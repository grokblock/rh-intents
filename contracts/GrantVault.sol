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
    /**
     * The router calldata is inside the signed struct, as a hash.
     *
     * Without it a relayer could keep the agent's amounts and swap the ROUTE —
     * sending the trade through a pool it controls and taking the difference.
     * minOut and the tradeable allowlist bound how bad that could get, but
     * "bounded theft" is still theft, and the agent chose a route for a reason.
     */
    bytes32 private constant _SWAP_TYPEHASH = keccak256(
        "Swap(address agent,address tokenIn,address tokenOut,uint256 amountIn,uint256 minOut,bytes32 routerDataHash,uint256 nonce,uint256 deadline,uint32 generation)"
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

    // --------------------------------------------------------- subscriptions
    /**
     * Recurring payments, with double-charging made structurally impossible.
     *
     * WHY THE IDEMPOTENCY IS ON CHAIN
     * A scheduler that records "paid" in its own database can still pay twice:
     * it sends, crashes before writing, restarts, and sends again. No amount of
     * client care fixes that, because the crash window is between two systems.
     * `lastPaidPeriod` advances in the same transaction that moves the money, so
     * a second attempt at the same period reverts. The scheduler is then free to
     * be dumb and retry as often as it likes.
     *
     * MISSED PERIODS ARE NOT BACKFILLED
     * Only the current period is payable. Offline for three months does not wake
     * up and fire three charges — it pays the current period, and the gap stays
     * visible in `payments` and `lastPaidPeriod`. A surprise triple charge is a
     * worse failure than a missed month.
     *
     * ANYONE MAY TRIGGER ONE
     * Unlike the Solana original, which required the agent to sign each charge,
     * `paySubscription` is callable by anyone. Every parameter that decides where
     * the money goes — merchant, amount, period — was fixed by the owner at
     * creation, the agent's cap still meters it, and the merchant must still be
     * on the allowlist at payment time. So a caller can only ever cause a payment
     * the owner already authorised, on a schedule the owner already set. Making
     * it permissionless removes the failure mode where a subscription silently
     * lapses because the bot was down.
     */
    struct Subscription {
        address agent;      // whose grant pays
        address merchant;   // fixed at creation; must still be allowlisted when charged
        uint256 amount;     // raw token units
        uint64 periodSeconds;
        uint64 startTime;
        int64 lastPaidPeriod; // -1 means never paid; periods are 0-indexed from startTime
        uint32 payments;
        bool active;
    }

    /// A day is the shortest sane billing period. Anything faster is a drain
    /// vector wearing a subscription's clothes.
    uint64 public constant MIN_PERIOD_SECONDS = 1 days;
    int64 private constant PERIOD_NONE = -1;

    uint256 public nextSubscriptionId = 1;
    mapping(uint256 => Subscription) public subscriptions;

    error SubscriptionMissing();
    error SubscriptionInactive();
    error PeriodTooShort();
    error PeriodMismatch(int64 asserted, int64 current);
    error AlreadyPaidThisPeriod(int64 period);
    error NotStarted();

    event SubscriptionCreated(
        uint256 indexed id,
        address indexed agent,
        address indexed merchant,
        uint256 amount,
        uint64 periodSeconds,
        uint64 startTime
    );
    event SubscriptionPaid(uint256 indexed id, int64 period, uint256 amount, uint32 paymentsAfter);
    event SubscriptionCancelled(uint256 indexed id, uint32 payments, int64 lastPaidPeriod);

    function createSubscription(
        address agent,
        address merchant,
        uint256 amount,
        uint64 periodSeconds,
        uint64 startTime
    ) external onlyOwner returns (uint256 id) {
        if (amount == 0) revert ZeroAmount();
        if (periodSeconds < MIN_PERIOD_SECONDS) revert PeriodTooShort();
        // A subscription may only name a payee the owner already approved, so it
        // can never widen what the agent may pay.
        if (!isMerchant[merchant]) revert PayeeNotAllowed(merchant);
        if (grants[agent].expiresAt == 0) revert GrantMissing();

        // A future start lets a human line the first charge up with a billing date.
        uint64 start = startTime > block.timestamp ? startTime : uint64(block.timestamp);

        id = nextSubscriptionId++;
        subscriptions[id] = Subscription({
            agent: agent,
            merchant: merchant,
            amount: amount,
            periodSeconds: periodSeconds,
            startTime: start,
            lastPaidPeriod: PERIOD_NONE,
            payments: 0,
            active: true
        });
        emit SubscriptionCreated(id, agent, merchant, amount, periodSeconds, start);
    }

    /// Owner-only and immediate. The payee cannot object, delay, or require a
    /// cancellation flow to be navigated.
    function cancelSubscription(uint256 id) external onlyOwner {
        Subscription storage s = subscriptions[id];
        if (s.agent == address(0)) revert SubscriptionMissing();
        if (!s.active) revert SubscriptionInactive();
        s.active = false;
        emit SubscriptionCancelled(id, s.payments, s.lastPaidPeriod);
    }

    /// Which period `block.timestamp` falls in. Reverts before the start date.
    function currentPeriod(uint256 id) public view returns (int64) {
        Subscription storage s = subscriptions[id];
        if (s.agent == address(0)) revert SubscriptionMissing();
        if (block.timestamp < s.startTime) revert NotStarted();
        return int64(uint64((block.timestamp - s.startTime) / s.periodSeconds));
    }

    /// True when this period is payable right now. For a scheduler to check
    /// before spending gas on a call that would revert.
    function isDue(uint256 id) external view returns (bool due, int64 period) {
        Subscription storage s = subscriptions[id];
        if (s.agent == address(0) || !s.active) return (false, 0);
        if (block.timestamp < s.startTime) return (false, 0);
        period = int64(uint64((block.timestamp - s.startTime) / s.periodSeconds));
        due = period > s.lastPaidPeriod;
    }

    /**
     * Charge one period.
     *
     * The caller states which period it believes it is paying rather than
     * letting the contract infer it. A scheduler whose clock has drifted then
     * fails loudly instead of quietly charging the wrong cycle.
     */
    function paySubscription(uint256 id, int64 period) external nonReentrant {
        Subscription storage s = subscriptions[id];
        if (s.agent == address(0)) revert SubscriptionMissing();
        if (!s.active) revert SubscriptionInactive();
        if (block.timestamp < s.startTime) revert NotStarted();

        int64 current = int64(uint64((block.timestamp - s.startTime) / s.periodSeconds));
        if (period != current) revert PeriodMismatch(period, current);
        // THE idempotency check. Everything below is ordinary payment logic.
        if (period <= s.lastPaidPeriod) revert AlreadyPaidThisPeriod(period);

        // Effects first, same reasoning as _pay: the token is untrusted code and
        // must never be able to re-enter into a second charge for this period.
        s.lastPaidPeriod = period;
        unchecked {
            s.payments += 1;
        }
        emit SubscriptionPaid(id, period, s.amount, s.payments);

        // _pay re-checks the allowlist, the cap, the expiry and the revocation,
        // so removing the merchant or revoking the grant stops the subscription
        // without anyone having to touch the subscription itself.
        _pay(s.agent, s.merchant, s.amount);
    }

    // ----------------------------------------------------------------- swap
    /**
     * Trade from inside the mandate.
     *
     * WHY THE CONTRACT DOES NOT BUILD THE SWAP
     * This chain's router is a MODIFIED UniversalRouter: its v4 swap struct
     * carries an extra `minHopPriceX36` field, so calldata produced by the
     * standard Uniswap SDK reverts against it, and the encoding is free to
     * change again without warning. A contract that encoded routes itself would
     * be wrong the first time the router moved.
     *
     * So the caller supplies the router calldata and this contract enforces the
     * OUTCOME instead: at most `amountIn` may leave, at least `minOut` must
     * arrive, and both are measured from real balances after the call rather
     * than believed from a return value. Whatever the router did in between, it
     * cannot have done worse than the bounds. The router address is a constant,
     * so "arbitrary calldata" reaches exactly one program, never an attacker's.
     *
     * HOW THE ROUTER GETS PAID, AND WHY NOT BY APPROVAL
     * An earlier version approved the router for exactly `amountIn` and cleared
     * the allowance afterwards. Against the live router that does not work at
     * all, and finding out cost a simulation rather than money: UniversalRouter
     * never spends an allowance made to itself. With `payerIsUser = false` it
     * spends only its OWN balance, and with `true` it pulls through Permit2 —
     * a contract this vault has no reason to approve, since a Permit2 allowance
     * is exactly the standing capability the design refuses to leave lying about.
     *
     * So the input is TRANSFERRED to the router and the route runs with
     * `payerIsUser = false`. That is not a workaround; it is strictly better.
     * No allowance is created at any point, so the rule holds everywhere with no
     * exception, and a revoked mandate cannot leave a live capability behind.
     *
     * The cost is that a route consuming less than it was given strands the
     * remainder in the router. That is bounded by `amountIn` and visible in the
     * `spent` figure this function reports, and a caller who cares should append
     * a SWEEP command to their calldata to send the dust back.
     *
     * METERING, AND WHY SELLING IS FREE
     * Spending the mandate's asset meters the cap. Selling something back INTO
     * the mandate asset meters nothing, because it does not spend the budget — it
     * returns to it. That asymmetry is what makes `reviseGrant(cap = spent)` a
     * usable soft kill: an agent with no headroom can still unwind a position it
     * already holds, where a revoke would strand it.
     */
    address public constant ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;

    /// Tokens the agent may hold as swap output. An output token that is not on
    /// this list is a drain vector wearing a trade's clothes: sell the mandate
    /// asset for one wei of something worthless and the value is gone while the
    /// cap looks respected.
    mapping(address => bool) public isTradeable;

    error TokenNotTradeable(address token);
    error SwapSameToken();
    error Overspent(uint256 spent, uint256 allowed);
    error MinOutNotMet(uint256 received, uint256 required);
    error RouterCallFailed();
    error EmptyRouterData();

    event TradeableSet(address indexed token, bool allowed);
    event Swapped(
        address indexed agent,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 spent,
        uint256 received,
        uint256 meteredAgainstCap
    );

    function setTradeable(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        isTradeable[token] = allowed;
        emit TradeableSet(token, allowed);
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata routerData
    ) external nonReentrant returns (uint256 received) {
        return _swap(msg.sender, tokenIn, tokenOut, amountIn, minOut, routerData);
    }

    /**
     * Gasless trading: the agent signs, anyone relays, the relayer pays the gas.
     *
     * This is what makes trading keyless. Without it `swap` had to be sent by
     * the agent itself, which meant the agent needed the native token — the one
     * thing this whole design exists to avoid. The payment path had `payWithSig`
     * from the start; the swap path was simply missing its twin.
     *
     * Shares the nonce with `payWithSig` deliberately. One counter per agent
     * means intents are strictly sequential, so a relayer cannot reorder two
     * signed actions or hold one back to replay later against different state.
     */
    function swapWithSig(
        address agent,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata routerData,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant returns (uint256 received) {
        if (block.timestamp > deadline) revert SignatureExpired();
        Grant storage g = grants[agent];
        if (g.expiresAt == 0) revert GrantMissing();

        bytes32 structHash = keccak256(
            abi.encode(
                _SWAP_TYPEHASH,
                agent,
                tokenIn,
                tokenOut,
                amountIn,
                minOut,
                keccak256(routerData),
                nonces[agent],
                deadline,
                g.generation
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        if (_recover(digest, signature) != agent) revert BadSignature();

        unchecked {
            nonces[agent] += 1;
        }
        return _swap(agent, tokenIn, tokenOut, amountIn, minOut, routerData);
    }

    function _swap(
        address agent,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata routerData
    ) private returns (uint256 received) {
        if (amountIn == 0) revert ZeroAmount();
        if (routerData.length == 0) revert EmptyRouterData();
        if (tokenIn == tokenOut) revert SwapSameToken();

        Grant storage g = grants[agent];
        if (g.expiresAt == 0) revert GrantMissing();
        if (g.revoked) revert GrantRevoked();
        if (block.timestamp > g.expiresAt) revert GrantExpired();

        // Both sides must be assets the owner chose. The mandate asset is
        // implicitly tradeable — it is already the thing the cap is denominated
        // in — but anything else needs approving first.
        if (tokenIn != g.token && !isTradeable[tokenIn]) revert TokenNotTradeable(tokenIn);
        if (tokenOut != g.token && !isTradeable[tokenOut]) revert TokenNotTradeable(tokenOut);

        // Spending the mandate asset costs cap. Coming back to it costs nothing.
        uint256 metered = tokenIn == g.token ? amountIn : 0;
        if (metered != 0) {
            uint256 headroom = g.cap - g.spent;
            if (metered > headroom) revert CapExceeded(metered, headroom);
            // Effects before the external call, exactly as in _pay.
            g.spent += metered;
        }

        uint256 inBefore = _balanceOf(tokenIn);
        uint256 outBefore = _balanceOf(tokenOut);

        // Hand the router the input outright. It spends its own balance when the
        // route is built with payerIsUser = false; an allowance would simply be
        // ignored. Nothing is approved, here or anywhere else in this contract.
        _safeTransfer(tokenIn, ROUTER, amountIn);

        (bool ok, ) = ROUTER.call(routerData);
        if (!ok) revert RouterCallFailed();

        // Believe balances, not the router. A return value is whatever the
        // callee felt like saying; these two numbers are what actually happened.
        uint256 spent = inBefore - _balanceOf(tokenIn);
        received = _balanceOf(tokenOut) - outBefore;

        if (spent > amountIn) revert Overspent(spent, amountIn);
        if (received < minOut) revert MinOutNotMet(received, minOut);

        emit Swapped(agent, tokenIn, tokenOut, spent, received, metered);
    }

    function _balanceOf(address token) private view returns (uint256) {
        (bool ok, bytes memory data) =
            token.staticcall(abi.encodeWithSelector(IERC20.balanceOf.selector, address(this)));
        // A token whose balance cannot be read cannot be bounded, and an
        // unbounded swap is the thing this function exists to prevent.
        if (!ok || data.length < 32) revert TransferFailed();
        return abi.decode(data, (uint256));
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
