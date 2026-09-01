// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/**
 * Test tokens. NOT USDG, and never to be described as USDG — testnet 46630 has
 * no USDG deployed, so anything standing in for it there is a mock and mislabelling
 * one would be the sort of claim this project exists to avoid making.
 */
contract MockToken {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public immutable decimals;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint8 d) {
        decimals = d;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) public virtual returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Returns nothing from transfer, like USDT and friends. A strict bool decode
/// reverts on this, which is why the vault tolerates empty returndata.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}

/// Reports success while moving nothing. The vault cannot detect this and does
/// not claim to — the test exists to pin that limit honestly rather than imply
/// a guarantee that is not there.
contract LyingToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }
}

/// Re-enters the vault during transfer. This is the attack the
/// effects-before-interaction ordering in _pay exists to stop.
contract ReentrantToken is MockToken {
    address public vault;
    address public merchant;
    bool private _attacking;

    constructor() MockToken(6) {}

    function arm(address v, address m) external {
        vault = v;
        merchant = m;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        if (!_attacking && vault != address(0)) {
            _attacking = true;
            // Try to spend the same headroom a second time, mid-transfer.
            (bool ok,) = vault.call(abi.encodeWithSignature("pay(address,uint256)", merchant, amount));
            _attacking = false;
            require(!ok, "reentrancy succeeded");
        }
        return true;
    }
}
