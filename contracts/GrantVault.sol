// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/**
 * GrantVault — an agent spends from a human's vault without ever holding it.
 *
 * This is Grok Chain's capability model on an EVM chain. A human (the `owner`)
 * funds this contract and issues a Grant to an agent key: one asset, a cap, an
 * expiry, and a list of payees the owner approved. The agent signs; the contract
 * decides. The agent never custodies the funds, never receives an allowance, and
 * never needs gas.
 *
 * WHY NOT AN ERC-4337 ACCOUNT
 * The chain has all three EntryPoints deployed, and account abstraction is the
 * obvious home for "agent acts under policy". It is the right answer when the
 * agent needs a general account that can do arbitrary things subject to rules.
 * That is not this. Here the agent needs exactly one capability — move an
 * approved asset to an approved payee, up to a cap — and a purpose-built vault
 * expresses that in a fraction of the surface a 4337 account plus a custom
 * validator module would take. Less surface is the entire security argument, so
 * it wins. `payWithSig` gives the gasless property directly, without depending
 * on a bundler existing for this chain. A 4337 wrapper can sit on top later; the
 * reverse is not true.
 *
 * THE APPROVAL RULE
 * This contract never calls `approve`. An ERC-20 allowance is a standing
 * capability that outlives revocation: revoke the grant, and an allowance the
 * agent still holds keeps working. The vault holds the tokens and moves them
 * itself, so revocation is actually final.
 *
 * ONE ASSET PER GRANT
 * A cap is one number and has no idea what it is counting. The moment an agent
 * can spend two denominations against one cap, the cap stops meaning anything.
 * Each grant therefore pins a token, and a second asset means a second agent —
 * the same rule the Solana original arrived at, for the same reason.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract GrantVault {
    // ---------------------------------------------------------------- errors
    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    error ZeroAmount();
    error GrantMissing();
    error GrantRevoked();
    error GrantExpired();
    error CapExceeded(uint256 requested, uint256 remaining);
    error PayeeNotAllowed(address payee);
    error TokenMismatch(address expected, address got);
    error ExpiryInPast();
    error CapBelowSpent(uint256 cap, uint256 spent);
    error MerchantLimit();
    error TransferFailed();
    error SignatureExpired();
    error BadSignature();
    error AgentIsOwner();

    // ---------------------------------------------------------------- events
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    event GrantIssued(
        address indexed agent, address indexed token, uint256 cap, uint48 expiresAt, uint32 generation
    );
    event GrantRevised(address indexed agent, uint256 cap, uint48 expiresAt, uint256 spent);
    event GrantRevokedEvent(address indexed agent, uint256 spent, uint32 generation);
    event MerchantAdded(address indexed merchant);
    event MerchantRemoved(address indexed merchant);
    event Paid(
        address indexed agent, address indexed merchant, address indexed token, uint256 amount, uint256 spentAfter
    );
    event Deposited(address indexed from, address indexed token, uint256 amount);
    event Withdrawn(address indexed to, address indexed token, uint256 amount);

    // ----------------------------------------------------------------- types
    struct Grant {
        address token;      // the ONE asset this agent may spend
        uint256 cap;        // raw token units, not decimal-adjusted
        uint256 spent;      // monotonic; never reset, so history survives a revise
        uint48 expiresAt;   // unix seconds; 0 means "no grant", never "forever"
        bool revoked;
        uint32 generation;  // bumps on re-issue so old signed intents die
    }

    /// A payee list of this size is a design statement: an allowlist you cannot
    /// read at a glance is not one a human is really approving.
    uint256 public constant MAX_MERCHANTS = 32;

    address public owner;
    address public pendingOwner;

    mapping(address => Grant) public grants;
    address[] private _merchants;
    mapping(address => bool) public isMerchant;

    /// Replay protection for payWithSig. Bumps on every relayed payment.
    mapping(address => uint256) public nonces;

    bytes32 private constant _PAY_TYPEHASH = keccak256(
        "Pay(address agent,address merchant,uint256 amount,uint256 nonce,uint256 deadline,uint32 generation)"
    );
    bytes32 private immutable _DOMAIN_SEPARATOR;
    uint256 private immutable _CACHED_CHAIN_ID;

    /// Reentrancy guard. The token is untrusted: a callback token could re-enter
    /// `pay` mid-transfer. Metering happens before the transfer anyway (see
    /// `_pay`), so this is the second lock rather than the only one.
    uint256 private _entered = 1;

    modifier nonReentrant() {
        require(_entered == 1, "reentrant");
        _entered = 2;
        _;
        _entered = 1;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        owner = initialOwner;
        _CACHED_CHAIN_ID = block.chainid;
        _DOMAIN_SEPARATOR = _buildDomainSeparator();
        emit OwnershipTransferred(address(0), initialOwner);
    }

    // ------------------------------------------------------------- ownership
    /// Two-step on purpose: a one-step transfer to a mistyped address is
    /// unrecoverable, and this contract is where the money lives.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address old = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(old, msg.sender);
    }

    // ----------------------------------------------------------------- funds
    /// Pull tokens in. Anyone may fund; only the owner may take out.
    function deposit(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _safeTransferFrom(token, msg.sender, address(this), amount);
        emit Deposited(msg.sender, token, amount);
    }

    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _safeTransfer(token, to, amount);
        emit Withdrawn(to, token, amount);
    }

    // ---------------------------------------------------------------- grants
    function issueGrant(address agent, address token, uint256 cap, uint48 expiresAt) external onlyOwner {
        if (agent == address(0) || token == address(0)) revert ZeroAddress();
        // An agent that is also the owner is not an agent; it is the owner with
        // extra steps, and the cap would be theatre.
        if (agent == owner) revert AgentIsOwner();
        if (cap == 0) revert ZeroAmount();
        if (expiresAt <= block.timestamp) revert ExpiryInPast();

        Grant storage g = grants[agent];
        // `spent` deliberately survives re-issue. Resetting it would make a
        // fresh grant the way to erase an agent's history.
        g.token = token;
        g.cap = cap;
        g.expiresAt = expiresAt;
        g.revoked = false;
        unchecked {
            g.generation += 1;
        }
        emit GrantIssued(agent, token, cap, expiresAt, g.generation);
    }

    /**
     * The soft kill.
     *
     * Setting `cap` to the agent's current `spent` leaves zero headroom, so no
     * further payment can succeed — while the grant itself stays alive. That
     * matters wherever an agent must still be able to act without being able to
     * spend, and it is why revocation is not always the right tool.
     */
    function reviseGrant(address agent, uint256 cap, uint48 expiresAt) external onlyOwner {
        Grant storage g = grants[agent];
        if (g.expiresAt == 0) revert GrantMissing();
        if (cap < g.spent) revert CapBelowSpent(cap, g.spent);
        if (expiresAt <= block.timestamp) revert ExpiryInPast();
        g.cap = cap;
        g.expiresAt = expiresAt;
        emit GrantRevised(agent, cap, expiresAt, g.spent);
    }

    function revokeGrant(address agent) external onlyOwner {
        Grant storage g = grants[agent];
        if (g.expiresAt == 0) revert GrantMissing();
        g.revoked = true;
        // Bump so any pre-signed intent for this agent is dead even if the grant
        // is later re-issued.
        unchecked {
            g.generation += 1;
        }
        emit GrantRevokedEvent(agent, g.spent, g.generation);
    }

    // ------------------------------------------------------------- merchants
    function addMerchant(address merchant) external onlyOwner {
        if (merchant == address(0)) revert ZeroAddress();
        if (isMerchant[merchant]) return;
        if (_merchants.length >= MAX_MERCHANTS) revert MerchantLimit();
        isMerchant[merchant] = true;
        _merchants.push(merchant);
        emit MerchantAdded(merchant);
    }

    /// Immediate. The next payment to this address fails; the payee cannot
    /// object, delay, or require a cancellation flow.
    function removeMerchant(address merchant) external onlyOwner {
        if (!isMerchant[merchant]) return;
        isMerchant[merchant] = false;
        uint256 n = _merchants.length;
        for (uint256 i = 0; i < n; ++i) {
            if (_merchants[i] == merchant) {
                _merchants[i] = _merchants[n - 1];
                _merchants.pop();
                break;
            }
        }
        emit MerchantRemoved(merchant);
    }

    function merchants() external view returns (address[] memory) {
        return _merchants;
    }

    function merchantCount() external view returns (uint256) {
        return _merchants.length;
    }

    // ------------------------------------------------------------- payments
    /// The agent submits and pays its own gas. Use `payWithSig` for the
    /// gasless path, which is the one that matters for a bot.
    function pay(address merchant, uint256 amount) external nonReentrant {
        _pay(msg.sender, merchant, amount);
    }

    /**
     * Gasless: the agent signs, anyone relays, the relayer pays the gas.
     *
     * This is the property that lets a bot hold nothing at all — not the funds
     * and not the native token either. The signature covers the generation, so
     * revoking or re-issuing a grant invalidates every intent signed before it.
     */
    function payWithSig(
        address agent,
        address merchant,
        uint256 amount,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (block.timestamp > deadline) revert SignatureExpired();
        Grant storage g = grants[agent];
        if (g.expiresAt == 0) revert GrantMissing();

        bytes32 structHash = keccak256(
            abi.encode(_PAY_TYPEHASH, agent, merchant, amount, nonces[agent], deadline, g.generation)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        if (_recover(digest, signature) != agent) revert BadSignature();

        unchecked {
            nonces[agent] += 1;
        }
        _pay(agent, merchant, amount);
    }

    function _pay(address agent, address merchant, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        Grant storage g = grants[agent];
        if (g.expiresAt == 0) revert GrantMissing();
        if (g.revoked) revert GrantRevoked();
        if (block.timestamp > g.expiresAt) revert GrantExpired();
        if (!isMerchant[merchant]) revert PayeeNotAllowed(merchant);

        uint256 headroom = g.cap - g.spent; // cap >= spent is an invariant
        if (amount > headroom) revert CapExceeded(amount, headroom);

        // Effects before interaction. The token is untrusted code: if metering
        // happened after the transfer, a callback token could re-enter and spend
        // the same headroom twice. This ordering is the actual fix; the
        // reentrancy guard is belt to its braces.
        g.spent += amount;

        address token = g.token;
        emit Paid(agent, merchant, token, amount, g.spent);
        _safeTransfer(token, merchant, amount);
    }

    // ----------------------------------------------------------------- views
    function remaining(address agent) external view returns (uint256) {
        Grant storage g = grants[agent];
        if (g.expiresAt == 0 || g.revoked || block.timestamp > g.expiresAt) return 0;
        return g.cap - g.spent;
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparator();
    }

    // --------------------------------------------------------------- private
    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("GrantVault"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    /// Rebuild if the chain forked under us, so a signature for the old chain id
    /// cannot be replayed on the new one.
    function _domainSeparator() private view returns (bytes32) {
        return block.chainid == _CACHED_CHAIN_ID ? _DOMAIN_SEPARATOR : _buildDomainSeparator();
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        // Reject the upper half of the curve order: every signature has a second
        // valid form, and accepting both would make the nonce the only thing
        // stopping a duplicate.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert BadSignature();
        }
        if (v != 27 && v != 28) revert BadSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }

    /// USDG returns a bool, but plenty of ERC-20s return nothing at all and
    /// would revert a strict `bool` decode. Accept both, reject a false.
    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
