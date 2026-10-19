// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface IMintable {
    function mint(address to, uint256 amount) external;
}

interface IBurnable {
    function burn(uint256 amount) external;
}

/// @title PromptCraftVault
/// @notice Custodial in-game balances, backed 1:1 by ERC20 tokens held by this contract.
///         Game accounts (players, AI agents, citizens, treasuries) are bytes32 ids. The game server (an operator)
///         moves value between them, usually many moves in one `batch` transaction, so players need no wallet or gas.
///         Works with any ERC20. If a token lets this vault mint (e.g. MockToken.setMinter), a central bank can
///         `print` new money into a treasury. Anyone can `deposit` real tokens to fund an account; operators can
///         `withdraw` an account's tokens to an address.
contract PromptCraftVault {
    address public owner;
    mapping(address => bool) public operators;

    /// token => account => amount
    mapping(address => mapping(bytes32 => uint256)) public balanceOf;
    /// token => sum of every account's balance (always <= the vault's token balance)
    mapping(address => uint256) public totalHeld;

    uint8 internal constant MOVE = 0;
    uint8 internal constant PRINT = 1;
    uint8 internal constant BURN = 2;

    struct Op {
        uint8 kind; // 0 move, 1 print, 2 burn
        address token;
        bytes32 from;
        bytes32 to;
        uint256 amount;
        string memo;
    }

    event Moved(address indexed token, bytes32 indexed from, bytes32 indexed to, uint256 amount, string memo);
    event Printed(address indexed token, bytes32 indexed to, uint256 amount, string memo);
    event Burned(address indexed token, bytes32 indexed from, uint256 amount, string memo);
    event Deposited(address indexed token, bytes32 indexed to, address indexed sender, uint256 amount, string memo);
    event Withdrawn(address indexed token, bytes32 indexed from, address indexed recipient, uint256 amount, string memo);
    event OperatorSet(address indexed operator, bool allowed);

    modifier onlyOperator() {
        require(operators[msg.sender], "Vault: not operator");
        _;
    }

    constructor() {
        owner = msg.sender;
        operators[msg.sender] = true;
        emit OperatorSet(msg.sender, true);
    }

    function setOperator(address operator, bool allowed) external {
        require(msg.sender == owner, "Vault: not owner");
        operators[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function move(address token, bytes32 from, bytes32 to, uint256 amount, string calldata memo) external onlyOperator {
        _move(token, from, to, amount, memo);
    }

    function print(address token, bytes32 to, uint256 amount, string calldata memo) external onlyOperator {
        _print(token, to, amount, memo);
    }

    function burn(address token, bytes32 from, uint256 amount, string calldata memo) external onlyOperator {
        _burn(token, from, amount, memo);
    }

    /// @notice Apply many operations in order; reverts as a whole if any one fails.
    function batch(Op[] calldata ops) external onlyOperator {
        for (uint256 i = 0; i < ops.length; i++) {
            Op calldata op = ops[i];
            if (op.kind == MOVE) _move(op.token, op.from, op.to, op.amount, op.memo);
            else if (op.kind == PRINT) _print(op.token, op.to, op.amount, op.memo);
            else if (op.kind == BURN) _burn(op.token, op.from, op.amount, op.memo);
            else revert("Vault: bad op");
        }
    }

    /// @notice Fund a game account with real tokens (needs an ERC20 approval first).
    function deposit(address token, bytes32 to, uint256 amount, string calldata memo) external {
        require(IERC20Min(token).transferFrom(msg.sender, address(this), amount), "Vault: transferFrom failed");
        balanceOf[token][to] += amount;
        totalHeld[token] += amount;
        emit Deposited(token, to, msg.sender, amount, memo);
    }

    function withdraw(address token, bytes32 from, address recipient, uint256 amount, string calldata memo) external onlyOperator {
        _debit(token, from, amount);
        totalHeld[token] -= amount;
        require(IERC20Min(token).transfer(recipient, amount), "Vault: transfer failed");
        emit Withdrawn(token, from, recipient, amount, memo);
    }

    function balancesOf(address token, bytes32[] calldata accounts) external view returns (uint256[] memory out) {
        out = new uint256[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) out[i] = balanceOf[token][accounts[i]];
    }

    function _debit(address token, bytes32 from, uint256 amount) internal {
        uint256 b = balanceOf[token][from];
        require(b >= amount, "Vault: insufficient balance");
        unchecked {
            balanceOf[token][from] = b - amount;
        }
    }

    function _move(address token, bytes32 from, bytes32 to, uint256 amount, string calldata memo) internal {
        _debit(token, from, amount);
        balanceOf[token][to] += amount;
        emit Moved(token, from, to, amount, memo);
    }

    function _print(address token, bytes32 to, uint256 amount, string calldata memo) internal {
        IMintable(token).mint(address(this), amount);
        balanceOf[token][to] += amount;
        totalHeld[token] += amount;
        emit Printed(token, to, amount, memo);
    }

    function _burn(address token, bytes32 from, uint256 amount, string calldata memo) internal {
        _debit(token, from, amount);
        totalHeld[token] -= amount;
        try IBurnable(token).burn(amount) {} catch {
            require(IERC20Min(token).transfer(address(0x000000000000000000000000000000000000dEaD), amount), "Vault: burn failed");
        }
        emit Burned(token, from, amount, memo);
    }
}
