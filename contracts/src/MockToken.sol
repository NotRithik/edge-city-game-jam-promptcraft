// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockToken
/// @notice A plain ERC20 for PromptCraft's in-game currencies on test chains and forks.
///         MOCK: it has no real-world value. The owner can add minters (for example the PromptCraftVault,
///         so the game's central bank can "print money").
contract MockToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    address public owner;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isMinter;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MinterSet(address indexed minter, bool allowed);
    event OwnerChanged(address indexed owner);

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
        owner = msg.sender;
        isMinter[msg.sender] = true;
        emit MinterSet(msg.sender, true);
    }

    function setMinter(address minter, bool allowed) external {
        require(msg.sender == owner, "MockToken: not owner");
        isMinter[minter] = allowed;
        emit MinterSet(minter, allowed);
    }

    function setOwner(address newOwner) external {
        require(msg.sender == owner, "MockToken: not owner");
        owner = newOwner;
        emit OwnerChanged(newOwner);
    }

    function mint(address to, uint256 amount) external {
        require(isMinter[msg.sender], "MockToken: not minter");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        emit Transfer(msg.sender, address(0), amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "MockToken: allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "MockToken: balance");
        unchecked {
            balanceOf[from] -= amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
