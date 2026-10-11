// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TALLY reviewer-assigned escrow
/// @notice Escrow where a protocol-appointed reviewer, not the requester, decides settlement.
/// @dev Task text and evidence stay off-chain; only metadata/evidence hashes are anchored here.
contract ReviewerEscrow {
    enum State {
        OPEN,
        SUBMISSIONS_RECEIVED,
        AWARDED,
        CANCELLED
    }

    enum SubmissionState {
        NONE,
        SUBMITTED,
        APPROVED,
        REJECTED
    }

    struct Bounty {
        address requester;
        address reviewer;
        address backupReviewer;
        uint64 submissionDeadline;
        uint64 reviewDeadline;
        uint256 reward;
        bytes32 metadataHash;
        State state;
        address winner;
    }

    struct Submission {
        bytes32 evidenceHash;
        SubmissionState state;
    }

    address public owner;
    uint64 public reviewWindow;
    address public primaryReviewer;
    address public backupReviewer;
    uint256 public nextBountyId;

    mapping(uint256 => Bounty) public bounties;
    mapping(uint256 => mapping(address => Submission)) public submissions;
    mapping(uint256 => uint256) public submissionCount;

    bool private locked;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ReviewersUpdated(address indexed primaryReviewer, address indexed backupReviewer);
    event ReviewWindowUpdated(uint64 reviewWindow);
    event BountyCreated(
        uint256 indexed bountyId,
        address indexed requester,
        address indexed reviewer,
        uint256 reward,
        uint64 submissionDeadline,
        uint64 reviewDeadline,
        bytes32 metadataHash
    );
    event SubmissionRegistered(uint256 indexed bountyId, address indexed agent, bytes32 evidenceHash);
    event SubmissionRejected(uint256 indexed bountyId, address indexed agent, bytes32 evidenceHash);
    event SubmissionApproved(uint256 indexed bountyId, address indexed agent, uint256 reward);
    event BackupReviewerActivated(uint256 indexed bountyId, address indexed reviewer, uint64 reviewDeadline);
    event BountyCancelled(uint256 indexed bountyId, uint256 refund);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyAssignedReviewer(uint256 bountyId) {
        require(msg.sender == bounties[bountyId].reviewer, "not assigned reviewer");
        _;
    }

    modifier onlyRequester(uint256 bountyId) {
        require(msg.sender == bounties[bountyId].requester, "not requester");
        _;
    }

    modifier nonReentrant() {
        require(!locked, "reentrant call");
        locked = true;
        _;
        locked = false;
    }

    constructor(address initialReviewer, address initialBackupReviewer, uint64 initialReviewWindow) {
        require(initialReviewer != address(0), "reviewer required");
        require(initialBackupReviewer != address(0), "backup reviewer required");
        require(initialReviewer != initialBackupReviewer, "reviewers must differ");
        require(initialReviewWindow > 0, "review window required");
        owner = msg.sender;
        primaryReviewer = initialReviewer;
        backupReviewer = initialBackupReviewer;
        reviewWindow = initialReviewWindow;
        emit OwnershipTransferred(address(0), msg.sender);
        emit ReviewersUpdated(initialReviewer, initialBackupReviewer);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "owner required");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice The protocol owner controls the reviewer service, never the bounty requester.
    function setReviewers(address newPrimaryReviewer, address newBackupReviewer) external onlyOwner {
        require(newPrimaryReviewer != address(0), "reviewer required");
        require(newBackupReviewer != address(0), "backup reviewer required");
        require(newPrimaryReviewer != newBackupReviewer, "reviewers must differ");
        primaryReviewer = newPrimaryReviewer;
        backupReviewer = newBackupReviewer;
        emit ReviewersUpdated(newPrimaryReviewer, newBackupReviewer);
    }

    function setReviewWindow(uint64 newReviewWindow) external onlyOwner {
        require(newReviewWindow > 0, "review window required");
        reviewWindow = newReviewWindow;
        emit ReviewWindowUpdated(newReviewWindow);
    }

    function createBounty(bytes32 metadataHash, uint64 submissionDeadline) external payable returns (uint256 bountyId) {
        require(msg.value > 0, "reward required");
        require(submissionDeadline > block.timestamp, "deadline must be future");

        bountyId = nextBountyId++;
        uint64 reviewDeadline = submissionDeadline + reviewWindow;
        bounties[bountyId] = Bounty({
            requester: msg.sender,
            reviewer: primaryReviewer,
            backupReviewer: backupReviewer,
            submissionDeadline: submissionDeadline,
            reviewDeadline: reviewDeadline,
            reward: msg.value,
            metadataHash: metadataHash,
            state: State.OPEN,
            winner: address(0)
        });

        emit BountyCreated(
            bountyId,
            msg.sender,
            primaryReviewer,
            msg.value,
            submissionDeadline,
            reviewDeadline,
            metadataHash
        );
    }

    function registerSubmission(uint256 bountyId, bytes32 evidenceHash) external {
        Bounty storage bounty = bounties[bountyId];
        require(bounty.requester != address(0), "unknown bounty");
        require(bounty.state == State.OPEN || bounty.state == State.SUBMISSIONS_RECEIVED, "not accepting submissions");
        require(block.timestamp < bounty.submissionDeadline, "submission deadline passed");
        require(submissions[bountyId][msg.sender].state == SubmissionState.NONE, "already submitted");
        require(evidenceHash != bytes32(0), "evidence hash required");

        submissions[bountyId][msg.sender] = Submission({ evidenceHash: evidenceHash, state: SubmissionState.SUBMITTED });
        submissionCount[bountyId] += 1;
        bounty.state = State.SUBMISSIONS_RECEIVED;
        emit SubmissionRegistered(bountyId, msg.sender, evidenceHash);
    }

    /// @notice Only the assigned protocol reviewer can approve and release escrow.
    function approveSubmission(uint256 bountyId, address payable agent) external onlyAssignedReviewer(bountyId) nonReentrant {
        Bounty storage bounty = bounties[bountyId];
        Submission storage submission = submissions[bountyId][agent];
        require(bounty.state == State.SUBMISSIONS_RECEIVED, "not ready to review");
        require(block.timestamp <= bounty.reviewDeadline, "review window passed");
        require(submission.state == SubmissionState.SUBMITTED, "submission unavailable");

        submission.state = SubmissionState.APPROVED;
        bounty.state = State.AWARDED;
        bounty.winner = agent;
        uint256 reward = bounty.reward;
        bounty.reward = 0;
        (bool paid, ) = agent.call{value: reward}("");
        require(paid, "payment failed");
        emit SubmissionApproved(bountyId, agent, reward);
    }

    /// @notice Rejection is public and reviewable; it does not let the requester take the reward.
    function rejectSubmission(uint256 bountyId, address agent) external onlyAssignedReviewer(bountyId) {
        Bounty storage bounty = bounties[bountyId];
        Submission storage submission = submissions[bountyId][agent];
        require(bounty.state == State.SUBMISSIONS_RECEIVED, "not ready to review");
        require(block.timestamp <= bounty.reviewDeadline, "review window passed");
        require(submission.state == SubmissionState.SUBMITTED, "submission unavailable");
        submission.state = SubmissionState.REJECTED;
        emit SubmissionRejected(bountyId, agent, submission.evidenceHash);
    }

    /// @notice If the primary reviewer misses the SLA, activate the pre-registered backup reviewer.
    function activateBackupReviewer(uint256 bountyId) external {
        Bounty storage bounty = bounties[bountyId];
        require(bounty.state == State.SUBMISSIONS_RECEIVED, "not awaiting review");
        require(block.timestamp > bounty.reviewDeadline, "review window active");
        require(bounty.reviewer != bounty.backupReviewer, "backup already active");
        bounty.reviewer = bounty.backupReviewer;
        bounty.reviewDeadline = uint64(block.timestamp) + reviewWindow;
        emit BackupReviewerActivated(bountyId, bounty.reviewer, bounty.reviewDeadline);
    }

    /// @notice If the reviewer service misses both windows, anyone can return the locked reward.
    function refundAfterReviewTimeout(uint256 bountyId) external nonReentrant {
        Bounty storage bounty = bounties[bountyId];
        require(bounty.state == State.SUBMISSIONS_RECEIVED, "not awaiting review");
        require(bounty.reviewer == bounty.backupReviewer, "activate backup reviewer first");
        require(block.timestamp > bounty.reviewDeadline, "review window active");
        bounty.state = State.CANCELLED;
        uint256 refund = bounty.reward;
        bounty.reward = 0;
        (bool paid, ) = payable(bounty.requester).call{value: refund}("");
        require(paid, "refund failed");
        emit BountyCancelled(bountyId, refund);
    }

    /// @notice Requesters may cancel only before any agent submits, so they cannot block a submitted agent.
    function cancelBounty(uint256 bountyId) external onlyRequester(bountyId) nonReentrant {
        Bounty storage bounty = bounties[bountyId];
        require(bounty.state == State.OPEN, "submissions already received");
        bounty.state = State.CANCELLED;
        uint256 refund = bounty.reward;
        bounty.reward = 0;
        (bool paid, ) = payable(bounty.requester).call{value: refund}("");
        require(paid, "refund failed");
        emit BountyCancelled(bountyId, refund);
    }

    receive() external payable {
        revert("use createBounty");
    }
}
