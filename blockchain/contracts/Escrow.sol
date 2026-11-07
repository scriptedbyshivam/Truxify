// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Truxify Escrow
/// @notice Relayer-operated booking escrow with a customer/driver dispute
///         window. A relayer funds and settles bookings; either counterparty
///         can raise a dispute, and the customer may claim a timeout refund if
///         the dispute is not resolved within DISPUTE_TIMELOCK.
contract Escrow {
    enum EscrowStatus {
        None,
        Funded,
        Released,
        Refunded
    }

    struct BookingEscrow {
        address payable customer;
        address payable driver;
        uint256 amount;
        EscrowStatus status;
        bool isDisputed;
        uint256 disputeTimestamp;
    }

    // 7-day timeout window for admin/relayer dispute resolution.
    uint256 public constant DISPUTE_TIMELOCK = 7 days;

    address public owner;
    mapping(address => bool) public authorizedRelayers;
    mapping(bytes32 => BookingEscrow) public escrows;
    bool private locked;

    event RelayerUpdated(address indexed relayer, bool authorized);
    event Deposited(bytes32 indexed bookingId, address indexed customer, address indexed driver, uint256 amount);
    event Released(bytes32 indexed bookingId, address indexed driver, uint256 amount);
    event Refunded(bytes32 indexed bookingId, address indexed customer, uint256 amount);
    event DisputeRaised(bytes32 indexed bookingId, address indexed raisedBy, uint256 timestamp);
    event DisputeTimeoutRefunded(bytes32 indexed bookingId, address indexed customer, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    modifier onlyRelayer() {
        require(authorizedRelayers[msg.sender], "Not authorized relayer");
        _;
    }

    modifier nonReentrant() {
        require(!locked, "Reentrant call");
        locked = true;
        _;
        locked = false;
    }

    constructor(address initialRelayer) {
        owner = msg.sender;
        if (initialRelayer != address(0)) {
            authorizedRelayers[initialRelayer] = true;
            emit RelayerUpdated(initialRelayer, true);
        }
    }

    function setRelayer(address relayer, bool authorized) external onlyOwner {
        require(relayer != address(0), "Invalid relayer");
        authorizedRelayers[relayer] = authorized;
        emit RelayerUpdated(relayer, authorized);
    }

    function deposit(bytes32 bookingId, address payable customer, address payable driver) external payable {
        require(
            msg.sender == customer || authorizedRelayers[msg.sender] || msg.sender == owner,
            "Not authorized to deposit"
        );
        require(bookingId != bytes32(0), "Invalid booking");
        require(customer != address(0), "Invalid customer");
        require(driver != address(0), "Invalid driver");
        require(msg.value > 0, "Deposit required");
        require(escrows[bookingId].status == EscrowStatus.None, "Escrow exists");

        escrows[bookingId] = BookingEscrow({
            customer: customer,
            driver: driver,
            amount: msg.value,
            status: EscrowStatus.Funded,
            isDisputed: false,
            disputeTimestamp: 0
        });

        emit Deposited(bookingId, customer, driver, msg.value);
    }

    /// @notice Raises a dispute on a funded escrow. Callable by the customer or
    ///         the driver only.
    function raiseDispute(bytes32 bookingId) external {
        BookingEscrow storage booking = escrows[bookingId];
        require(msg.sender == booking.customer || msg.sender == booking.driver, "Unauthorized");
        require(booking.status == EscrowStatus.Funded, "Escrow not funded");
        require(!booking.isDisputed, "Dispute already active");

        booking.isDisputed = true;
        booking.disputeTimestamp = block.timestamp;

        emit DisputeRaised(bookingId, msg.sender, block.timestamp);
    }

    /// @notice Lets the customer claim a refund if the relayer does not resolve
    ///         a dispute within DISPUTE_TIMELOCK.
    function refundAfterDisputeTimeout(bytes32 bookingId) external nonReentrant {
        BookingEscrow storage booking = escrows[bookingId];
        require(booking.isDisputed, "Escrow is not in dispute");
        require(booking.status == EscrowStatus.Funded, "Escrow not funded");
        require(block.timestamp > booking.disputeTimestamp + DISPUTE_TIMELOCK, "Dispute timelock has not expired");
        require(msg.sender == booking.customer, "Only customer can claim timeout refund");

        booking.status = EscrowStatus.Refunded;
        booking.isDisputed = false;
        uint256 amount = booking.amount;
        booking.amount = 0;

        (bool sent, ) = booking.customer.call{value: amount}("");
        require(sent, "Customer refund failed");

        emit DisputeTimeoutRefunded(bookingId, booking.customer, amount);
    }

    function releaseFunds(bytes32 bookingId) external onlyRelayer nonReentrant {
        BookingEscrow storage booking = escrows[bookingId];
        require(booking.status == EscrowStatus.Funded, "Escrow not funded");

        booking.status = EscrowStatus.Released;
        uint256 amount = booking.amount;
        booking.amount = 0;

        (bool sent, ) = booking.driver.call{value: amount}("");
        require(sent, "Driver payout failed");

        emit Released(bookingId, booking.driver, amount);
    }

    function refundFunds(bytes32 bookingId) external onlyRelayer nonReentrant {
        BookingEscrow storage booking = escrows[bookingId];
        require(booking.status == EscrowStatus.Funded, "Escrow not funded");

        booking.status = EscrowStatus.Refunded;
        uint256 amount = booking.amount;
        booking.amount = 0;

        (bool sent, ) = booking.customer.call{value: amount}("");
        require(sent, "Customer refund failed");

        emit Refunded(bookingId, booking.customer, amount);
    }
}
