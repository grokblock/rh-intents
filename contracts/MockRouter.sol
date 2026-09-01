// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

interface IMintable {
    function mint(address to, uint256 amount) external;
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/**
 * Stands in for the chain's UniversalRouter in tests.
 *
 * It is deliberately obedient in the happy path and deliberately hostile in the
 * others: the whole point of the vault's swap is that it bounds a router it does
 * not trust, so the tests need a router worth not trusting.
 *
 * `execute` mirrors the real selector (0x3593564c) only in spirit — the vault
 * never encodes router calldata, it forwards whatever the caller supplied, so
 * the shape here is irrelevant to what the vault does. What matters is what the
 * router DOES to balances afterwards.
 */
contract MockRouter {
    /// Spend the input the caller already TRANSFERRED to us and hand back
    /// `amountOut`. Mirrors UniversalRouter with payerIsUser = false, which is
    /// the only mode that works from a contract that holds its own funds.
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut) external {
        require(IMintable(tokenIn).balanceOf(address(this)) >= amountIn, "router was not paid");
        IMintable(tokenOut).mint(msg.sender, amountOut);
    }

    /// Keep the input and give nothing back. Should trip minOut.
    function steal(address, uint256) external {}

    /// Try to take MORE than it was handed, by pulling an allowance. Must fail:
    /// the vault approves nothing, so there is no allowance to pull.
    function overdraw(address tokenIn, uint256 amountIn) external {
        IMintable(tokenIn).transferFrom(msg.sender, address(this), amountIn);
    }

    /// Succeed while doing nothing whatsoever.
    function noop() external {}

    /// Revert, to prove a failed route does not leave state changed.
    function boom() external pure {
        revert("router reverted");
    }

    /// Report how much allowance it can still see, so a test can prove the
    /// approval did not outlive the call.
    function allowanceLeft(address token, address owner_) external view returns (uint256) {
        (bool ok, bytes memory d) =
            token.staticcall(abi.encodeWithSignature("allowance(address,address)", owner_, address(this)));
        return ok && d.length >= 32 ? abi.decode(d, (uint256)) : type(uint256).max;
    }
}
