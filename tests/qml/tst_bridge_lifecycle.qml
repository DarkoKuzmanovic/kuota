import QtQuick
import QtTest

import "../../plasmoid/contents/ui/bridge-lifecycle.js" as BridgeLifecycle

TestCase {
    name: "BridgeLifecycle"

    // --- Non-overlap / source-identity state machine ---------------------

    function test_initialStateIsNotInFlight() {
        var state = BridgeLifecycle.createRequestState();
        compare(BridgeLifecycle.isInFlight(state), false);
    }

    function test_beginRequestReservesSourceIdWithoutMarkingInFlight() {
        var state = BridgeLifecycle.createRequestState();
        var attempt = BridgeLifecycle.beginRequest(state);
        compare(attempt.started, true);
        compare(attempt.sourceId, 1);
        compare(BridgeLifecycle.isInFlight(attempt.state), false);
    }

    function test_activateMarksInFlightWithExactToken() {
        var state = BridgeLifecycle.createRequestState();
        var attempt = BridgeLifecycle.beginRequest(state);
        var activated = BridgeLifecycle.activate(attempt.state, attempt.sourceId, "token-a");
        compare(BridgeLifecycle.isInFlight(activated), true);
        compare(BridgeLifecycle.isActiveToken(activated, "token-a"), true);
        compare(BridgeLifecycle.isActiveToken(activated, "token-b"), false);
    }

    function test_beginRequestRejectsWhileInFlight() {
        var state = BridgeLifecycle.createRequestState();
        var attempt = BridgeLifecycle.beginRequest(state);
        var activated = BridgeLifecycle.activate(attempt.state, attempt.sourceId, "token-a");
        var second = BridgeLifecycle.beginRequest(activated);
        compare(second.started, false);
        compare(BridgeLifecycle.isActiveToken(second.state, "token-a"), true);
    }

    function test_clearIfActiveOnlyClearsExactMatchingToken() {
        var state = BridgeLifecycle.createRequestState();
        var attempt = BridgeLifecycle.beginRequest(state);
        var activated = BridgeLifecycle.activate(attempt.state, attempt.sourceId, "token-a");

        var unaffected = BridgeLifecycle.clearIfActive(activated, "foreign-token");
        compare(BridgeLifecycle.isInFlight(unaffected), true);
        compare(BridgeLifecycle.isActiveToken(unaffected, "token-a"), true);

        var cleared = BridgeLifecycle.clearIfActive(activated, "token-a");
        compare(BridgeLifecycle.isInFlight(cleared), false);
        compare(BridgeLifecycle.isActiveToken(cleared, "token-a"), false);
    }

    function test_lateOrForeignTokenIsNeverTreatedAsActiveAfterClear() {
        var state = BridgeLifecycle.createRequestState();
        var first = BridgeLifecycle.beginRequest(state);
        var firstActive = BridgeLifecycle.activate(first.state, first.sourceId, "token-1");
        var afterTimeout = BridgeLifecycle.clearIfActive(firstActive, "token-1");

        var second = BridgeLifecycle.beginRequest(afterTimeout);
        var secondActive = BridgeLifecycle.activate(second.state, second.sourceId, "token-2");

        // The original (now stale) token must never again be treated as active,
        // even though a new request is in flight.
        compare(BridgeLifecycle.isActiveToken(secondActive, "token-1"), false);
        compare(BridgeLifecycle.isActiveToken(secondActive, "token-2"), true);
    }

    function test_retryAllowedAfterClearWithMonotonicSourceIds() {
        var state = BridgeLifecycle.createRequestState();
        var first = BridgeLifecycle.beginRequest(state);
        var firstActive = BridgeLifecycle.activate(first.state, first.sourceId, "token-1");
        var cleared = BridgeLifecycle.clearIfActive(firstActive, "token-1");

        var second = BridgeLifecycle.beginRequest(cleared);
        compare(second.started, true);
        verify(second.sourceId > first.sourceId);
    }

    function test_advanceSourceCounterDoesNotMarkInFlight() {
        var state = BridgeLifecycle.createRequestState();
        var attempt = BridgeLifecycle.beginRequest(state);
        var advanced = BridgeLifecycle.advanceSourceCounter(attempt.state, attempt.sourceId);
        compare(BridgeLifecycle.isInFlight(advanced), false);

        var next = BridgeLifecycle.beginRequest(advanced);
        verify(next.sourceId > attempt.sourceId);
    }

    // --- Process result interpretation ------------------------------------

    function test_interpretsSuccessWithSpacedKeys() {
        var result = BridgeLifecycle.interpretProcessResult({
            "stdout": "{}",
            "stderr": "ignored",
            "exit code": 0,
            "exit status": 0
        });
        compare(result.outcome, BridgeLifecycle.PROCESS_OUTCOME.SUCCESS);
        compare(result.stdout, "{}");
    }

    function test_interpretsSuccessWithCamelCaseKeys() {
        var result = BridgeLifecycle.interpretProcessResult({
            stdout: "{}",
            stderr: "ignored",
            exitCode: 0,
            exitStatus: 0
        });
        compare(result.outcome, BridgeLifecycle.PROCESS_OUTCOME.SUCCESS);
        compare(result.stdout, "{}");
    }

    function test_neverExposesStderrOnSuccess() {
        var result = BridgeLifecycle.interpretProcessResult({
            stdout: "{}",
            stderr: "top secret diagnostic",
            exitCode: 0,
            exitStatus: 0
        });
        verify(!Object.prototype.hasOwnProperty.call(result, "stderr"));
    }

    function test_nonzeroExitCodeIsProcessFailure() {
        var result = BridgeLifecycle.interpretProcessResult({
            stdout: "",
            stderr: "",
            exitCode: 3,
            exitStatus: 0
        });
        compare(result.outcome, BridgeLifecycle.PROCESS_OUTCOME.PROCESS_FAILURE);
    }

    function test_crashExitStatusIsProcessFailureEvenWithZeroExitCode() {
        var result = BridgeLifecycle.interpretProcessResult({
            stdout: "",
            stderr: "",
            exitCode: 0,
            exitStatus: 1
        });
        compare(result.outcome, BridgeLifecycle.PROCESS_OUTCOME.PROCESS_FAILURE);
    }

    function test_missingKeysAreProcessFailure() {
        var result = BridgeLifecycle.interpretProcessResult({ stdout: "{}" });
        compare(result.outcome, BridgeLifecycle.PROCESS_OUTCOME.PROCESS_FAILURE);
    }

    function test_nonNumericExitKeysAreProcessFailure() {
        var result = BridgeLifecycle.interpretProcessResult({
            stdout: "{}",
            stderr: "",
            exitCode: "0",
            exitStatus: 0
        });
        compare(result.outcome, BridgeLifecycle.PROCESS_OUTCOME.PROCESS_FAILURE);
    }

    function test_nonStringStdoutIsProcessFailure() {
        var result = BridgeLifecycle.interpretProcessResult({
            stdout: 12345,
            stderr: "",
            exitCode: 0,
            exitStatus: 0
        });
        compare(result.outcome, BridgeLifecycle.PROCESS_OUTCOME.PROCESS_FAILURE);
    }

    function test_oversizedStdoutIsRejectedBeforeParsing() {
        var oversized = new Array(262146).join("a");
        var result = BridgeLifecycle.interpretProcessResult({
            stdout: oversized,
            stderr: "",
            exitCode: 0,
            exitStatus: 0
        });
        compare(result.outcome, BridgeLifecycle.PROCESS_OUTCOME.OVERSIZED_STDOUT);
    }

    function test_acceptsStdoutAtExactBoundary() {
        var atBoundary = new Array(262145).join("a");
        compare(atBoundary.length, BridgeLifecycle.MAX_STDOUT_LENGTH);
        var result = BridgeLifecycle.interpretProcessResult({
            stdout: atBoundary,
            stderr: "",
            exitCode: 0,
            exitStatus: 0
        });
        compare(result.outcome, BridgeLifecycle.PROCESS_OUTCOME.SUCCESS);
    }

    function test_neverThrowsForHostileProcessData() {
        var hostileValues = [null, undefined, 42, "data", [], true];
        for (var i = 0; i < hostileValues.length; i++) {
            var result = BridgeLifecycle.interpretProcessResult(hostileValues[i]);
            verify(result.outcome === BridgeLifecycle.PROCESS_OUTCOME.PROCESS_FAILURE ||
                result.outcome === BridgeLifecycle.PROCESS_OUTCOME.SUCCESS ||
                result.outcome === BridgeLifecycle.PROCESS_OUTCOME.OVERSIZED_STDOUT);
        }
    }
}
