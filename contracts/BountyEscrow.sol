// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BOT Agent Bounties escrow
/// @notice Minimal Phase 1 escrow for testnet validation.
/// @dev Full task text and evidence remain off-chain; only their hashes are anchored here.
contract BountyEscrow {
    enum State {
        OPEN,
        SUBMISSIONS_RECEIVED,
        AWARDED,
        CANCELLED
    }

    struct Bounty {
        address requester;
        uint64 deadline;
        uint256 reward;
        bytes32 metadataHash;
        State state;
        address winner;
    }

    uint256 public nextBountyId;
    mapping(uint256 => Bounty) public bounties;
    mapping(uint256 => mapping(address => bytes32)) public submissions;
    mapping(uint256 => mapping(address => bool)) public hasSubmitted;
    mapping(uint256 => uint256) public submissionCount;

    event BountyCreated(
        uint256 indexed bountyId,
        address indexed requester,
        uint256 reward,
        uint64 deadline,
        bytes32 metadataHash
    );
    event SubmissionRegistered(uint256 indexed bountyId, address indexed agent, bytes32 evidenceHash);
    event BountyAwarded(uint256 indexed bountyId, address indexed winner, uint256 reward);
    event BountyCancelled(uint256 indexed bountyId, uint256 refund);

    modifier onlyRequester(uint256 bountyId) {
        require(msg.sender == bounties[bountyId].requester, "not requester");
        _;
    }

    function createBounty(bytes32 metadataHash, uint64 deadline) external payable returns (uint256 bountyId) {
        require(msg.value > 0, "reward required");
        require(deadline > block.timestamp, "deadline must be future");

        bountyId = nextBountyId++;
        bounties[bountyId] = Bounty({
            requester: msg.sender,
            deadline: deadline,
            reward: msg.value,
            metadataHash: metadataHash,
            state: State.OPEN,
            winner: address(0)
        });

        emit BountyCreated(bountyId, msg.sender, msg.value, deadline, metadataHash);
    }

    function registerSubmission(uint256 bountyId, bytes32 evidenceHash) external {
        Bounty storage bounty = bounties[bountyId];
        require(bounty.requester != address(0), "unknown bounty");
        require(bounty.state == State.OPEN || bounty.state == State.SUBMISSIONS_RECEIVED, "not accepting submissions");
        require(block.timestamp < bounty.deadline, "deadline passed");
        require(!hasSubmitted[bountyId][msg.sender], "already submitted");
        require(evidenceHash != bytes32(0), "evidence hash required");

        submissions[bountyId][msg.sender] = evidenceHash;
        hasSubmitted[bountyId][msg.sender] = true;
        submissionCount[bountyId] += 1;
        bounty.state = State.SUBMISSIONS_RECEIVED;
        emit SubmissionRegistered(bountyId, msg.sender, evidenceHash);
    }

    function awardBounty(uint256 bountyId, address payable winner) external onlyRequester(bountyId) {
        Bounty storage bounty = bounties[bountyId];
        require(bounty.state == State.SUBMISSIONS_RECEIVED, "not ready to award");
        require(hasSubmitted[bountyId][winner], "winner has no submission");

        bounty.state = State.AWARDED;
        bounty.winner = winner;
        uint256 reward = bounty.reward;
        bounty.reward = 0;
        (bool paid, ) = winner.call{value: reward}("");
        require(paid, "payment failed");
        emit BountyAwarded(bountyId, winner, reward);
    }

    function cancelBounty(uint256 bountyId) external onlyRequester(bountyId) {
        Bounty storage bounty = bounties[bountyId];
        require(
            bounty.state == State.OPEN || bounty.state == State.SUBMISSIONS_RECEIVED,
            "cannot cancel"
        );
        require(
            bounty.state == State.OPEN || block.timestamp >= bounty.deadline,
            "submissions active"
        );

        bounty.state = State.CANCELLED;
        uint256 refund = bounty.reward;
        bounty.reward = 0;
        (bool paid, ) = payable(msg.sender).call{value: refund}("");
        require(paid, "refund failed");
        emit BountyCancelled(bountyId, refund);
    }

    receive() external payable {
        revert("use createBounty");
    }
}
