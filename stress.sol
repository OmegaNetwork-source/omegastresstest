// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract OmegaStressMock {
    event StressCalled(address indexed sender, uint256 value, bytes data, uint256 callType, string note);

    uint256 public callCount;
    mapping(address => uint256) public userCalls;

    // Accepts any data, emits an event, increments counters
    function stress(bytes calldata data, uint256 callType, string calldata note) external payable {
        callCount++;
        userCalls[msg.sender]++;
        emit StressCalled(msg.sender, msg.value, data, callType, note);
    }

    // Overloaded: just a number
    function stressNumber(uint256 n) external {
        callCount++;
        userCalls[msg.sender]++;
        emit StressCalled(msg.sender, 0, abi.encode(n), 1, "number");
    }

    // Overloaded: string
    function stressString(string calldata s) external {
        callCount++;
        userCalls[msg.sender]++;
        emit StressCalled(msg.sender, 0, bytes(s), 2, "string");
    }

    // Overloaded: random revert (for error testing)
    function stressMaybeRevert(uint256 n) external {
        callCount++;
        userCalls[msg.sender]++;
        if (n % 5 == 0) revert("Random revert for stress test");
        emit StressCalled(msg.sender, 0, abi.encode(n), 3, "maybeRevert");
    }
}
