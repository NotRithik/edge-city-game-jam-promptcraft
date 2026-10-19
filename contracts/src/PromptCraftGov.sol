// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PromptCraftGov
/// @notice The public record of PromptCraft's institutions: laws enacted by the AI cabinet or by player votes,
///         cabinet decisions, court cases and rulings, and approved public works. Events are the full history;
///         storage keeps the current law book. Only the game server (an operator) writes.
contract PromptCraftGov {
    address public owner;
    mapping(address => bool) public operators;

    /// nation => keccak256(law key) => current value
    mapping(bytes32 => mapping(bytes32 => string)) public law;
    uint256 public caseCount;
    uint256 public projectCount;

    event LawEnacted(bytes32 indexed nation, string key, string value, string by, string reason);
    event Decision(bytes32 indexed nation, string body, string summary);
    event CaseFiled(uint256 indexed id, bytes32 indexed nation, string plaintiff, string defendant, string claim);
    event Ruling(uint256 indexed id, string verdict, string remedy);
    event ProjectApproved(uint256 indexed id, bytes32 indexed nation, string name, uint256 budget, int32 x, int32 y, int32 z);
    event ProjectStatus(uint256 indexed id, string status);
    event OperatorSet(address indexed operator, bool allowed);

    modifier onlyOperator() {
        require(operators[msg.sender], "Gov: not operator");
        _;
    }

    constructor() {
        owner = msg.sender;
        operators[msg.sender] = true;
        emit OperatorSet(msg.sender, true);
    }

    function setOperator(address operator, bool allowed) external {
        require(msg.sender == owner, "Gov: not owner");
        operators[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function enact(bytes32 nation, string calldata key, string calldata value, string calldata by, string calldata reason) external onlyOperator {
        law[nation][keccak256(bytes(key))] = value;
        emit LawEnacted(nation, key, value, by, reason);
    }

    function decide(bytes32 nation, string calldata body, string calldata summary) external onlyOperator {
        emit Decision(nation, body, summary);
    }

    function fileCase(bytes32 nation, string calldata plaintiff, string calldata defendant, string calldata claim) external onlyOperator returns (uint256 id) {
        id = ++caseCount;
        emit CaseFiled(id, nation, plaintiff, defendant, claim);
    }

    function rule(uint256 id, string calldata verdict, string calldata remedy) external onlyOperator {
        require(id > 0 && id <= caseCount, "Gov: no such case");
        emit Ruling(id, verdict, remedy);
    }

    function approveProject(bytes32 nation, string calldata name, uint256 budget, int32 x, int32 y, int32 z) external onlyOperator returns (uint256 id) {
        id = ++projectCount;
        emit ProjectApproved(id, nation, name, budget, x, y, z);
    }

    function projectStatus(uint256 id, string calldata status) external onlyOperator {
        require(id > 0 && id <= projectCount, "Gov: no such project");
        emit ProjectStatus(id, status);
    }
}
