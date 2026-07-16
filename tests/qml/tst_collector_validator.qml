import QtQuick
import QtTest

import "../../plasmoid/contents/ui/collector-validator.js" as CollectorValidator
import "helpers/collector-fixtures.js" as Fixtures

TestCase {
    name: "CollectorValidator"

    function json(value) {
        return JSON.stringify(value);
    }

    // --- Input bounding ---------------------------------------------------

    function test_rejectsEmptyInput() {
        var result = CollectorValidator.validateCollectorResponse("");
        compare(result.ok, false);
        compare(result.code, CollectorValidator.VALIDATION_FAILURE.EMPTY_INPUT);
    }

    function test_rejectsNonStringInput() {
        var result = CollectorValidator.validateCollectorResponse(null);
        compare(result.ok, false);
        compare(result.code, CollectorValidator.VALIDATION_FAILURE.INVALID_INPUT_TYPE);
    }

    function test_rejectsOversizedInput() {
        var oversized = new Array(262146).join("a");
        var result = CollectorValidator.validateCollectorResponse(oversized);
        compare(result.ok, false);
        compare(result.code, CollectorValidator.VALIDATION_FAILURE.OVERSIZED_INPUT);
    }

    function test_acceptsInputAtTheBoundary() {
        var document = Fixtures.minimalDocument();
        var text = json(document);
        verify(text.length <= 262144);
        var result = CollectorValidator.validateCollectorResponse(text);
        compare(result.ok, true);
    }

    function test_rejectsMalformedJson() {
        var result = CollectorValidator.validateCollectorResponse("{not json");
        compare(result.ok, false);
        compare(result.code, CollectorValidator.VALIDATION_FAILURE.MALFORMED_JSON);
    }

    function test_rejectsNonObjectDocument() {
        var result = CollectorValidator.validateCollectorResponse("[]");
        compare(result.ok, false);
        compare(result.code, CollectorValidator.VALIDATION_FAILURE.SCHEMA_INVALID);
    }

    function test_neverThrowsForHostileInput() {
        var hostileInputs = ["null", "true", "42", "\"just a string\"", "{}", "[1,2,3]"];
        for (var i = 0; i < hostileInputs.length; i++) {
            var result = CollectorValidator.validateCollectorResponse(hostileInputs[i]);
            verify(result.ok === false || result.ok === true);
        }
    }

    // --- Whole-document shape ----------------------------------------------

    function test_acceptsMinimalValidDocument() {
        var result = CollectorValidator.validateCollectorResponse(json(Fixtures.minimalDocument()));
        compare(result.ok, true);
        compare(result.value.providers.length, 0);
    }

    function test_acceptsFullDocumentWithAllProviderStates() {
        var document = Fixtures.fullDocument();
        var result = CollectorValidator.validateCollectorResponse(json(document));
        compare(result.ok, true);
        compare(result.value.providers.length, 3);
        compare(result.value.providers[0].id, "claude");
        compare(result.value.providers[1].state, "auth-needed");
    }

    function test_acceptsValidPartialProviderSuccess() {
        var document = Fixtures.minimalDocument({ providers: [Fixtures.validClaudeProvider()] });
        var result = CollectorValidator.validateCollectorResponse(json(document));
        compare(result.ok, true);
        compare(result.value.providers.length, 1);
    }

    function test_acceptsValidStaleRecord() {
        var document = Fixtures.minimalDocument({ providers: [Fixtures.validStaleClaudeProvider()] });
        var result = CollectorValidator.validateCollectorResponse(json(document));
        compare(result.ok, true);
    }

    function test_acceptsUnlimitedPlanOmittingLimitAndPercent() {
        var provider = Fixtures.validClaudeProvider({
            windows: [Fixtures.validWindow({ usedPercent: undefined, limit: undefined, used: 5 })]
        });
        var result = CollectorValidator.validateCollectorResponse(
            json(Fixtures.minimalDocument({ providers: [provider] }))
        );
        compare(result.ok, true);
    }

    function test_rejectsUnsupportedSchemaVersion() {
        var document = Fixtures.minimalDocument({ schemaVersion: 2 });
        var result = CollectorValidator.validateCollectorResponse(json(document));
        compare(result.ok, false);
        compare(result.code, CollectorValidator.VALIDATION_FAILURE.SCHEMA_INVALID);
    }

    function test_rejectsMissingRequiredTopLevelField() {
        var document = Fixtures.minimalDocument();
        delete document.collectionFinishedAt;
        var result = CollectorValidator.validateCollectorResponse(json(document));
        compare(result.ok, false);
    }

    function test_rejectsUnknownTopLevelField() {
        var document = Fixtures.minimalDocument({ extra: "nope" });
        var result = CollectorValidator.validateCollectorResponse(json(document));
        compare(result.ok, false);
    }

    function test_rejectsNonArrayProviders() {
        var document = Fixtures.minimalDocument({ providers: {} });
        var result = CollectorValidator.validateCollectorResponse(json(document));
        compare(result.ok, false);
    }

    function test_rejectsInvalidTimestampFormat() {
        var document = Fixtures.minimalDocument({ collectionStartedAt: "not-a-timestamp" });
        var result = CollectorValidator.validateCollectorResponse(json(document));
        compare(result.ok, false);
    }

    function test_rejectsNonCanonicalTimestamp() {
        var document = Fixtures.minimalDocument({ collectionStartedAt: "2026-07-11T10:00:00+02:00" });
        var result = CollectorValidator.validateCollectorResponse(json(document));
        compare(result.ok, false);
    }

    function test_rejectsStartAfterFinish() {
        var document = Fixtures.minimalDocument({
            collectionStartedAt: "2026-07-11T10:00:02.000Z",
            collectionFinishedAt: "2026-07-11T10:00:01.000Z"
        });
        var result = CollectorValidator.validateCollectorResponse(json(document));
        compare(result.ok, false);
    }

    // --- Provider records ---------------------------------------------------

    function test_rejectsUnknownProviderId() {
        var document = Fixtures.minimalDocument({
            providers: [Fixtures.validClaudeProvider({ id: "unknown-provider" })]
        });
        var result = CollectorValidator.validateCollectorResponse(json(document));
        compare(result.ok, false);
    }

    function test_rejectsUnknownProviderState() {
        var document = Fixtures.minimalDocument({
            providers: [Fixtures.validClaudeProvider({ state: "not-a-state" })]
        });
        var result = CollectorValidator.validateCollectorResponse(json(document));
        compare(result.ok, false);
    }

    function test_rejectsDuplicateProviders() {
        var document = Fixtures.minimalDocument({
            providers: [Fixtures.validClaudeProvider(), Fixtures.validClaudeProvider()]
        });
        var result = CollectorValidator.validateCollectorResponse(json(document));
        compare(result.ok, false);
    }

    function test_rejectsUnknownProviderField() {
        var document = Fixtures.minimalDocument({
            providers: [Fixtures.validClaudeProvider({ unexpected: "value" })]
        });
        var result = CollectorValidator.validateCollectorResponse(json(document));
        compare(result.ok, false);
    }

    function test_rejectsCredentialShapedProviderField() {
        var document = Fixtures.minimalDocument({
            providers: [Fixtures.validClaudeProvider({ accountId: "acct_123" })]
        });
        var result = CollectorValidator.validateCollectorResponse(json(document));
        compare(result.ok, false);
    }

    function test_rejectsUnsafeStatusText() {
        var document = Fixtures.minimalDocument({
            providers: [Fixtures.validClaudeProvider({ status: "line1\nline2" })]
        });
        var result = CollectorValidator.validateCollectorResponse(json(document));
        compare(result.ok, false);
    }

    function test_rejectsCredentialShapedStatusText() {
        var document = Fixtures.minimalDocument({
            providers: [Fixtures.validClaudeProvider({ status: "Bearer sk-ant-abcdefgh12345678" })]
        });
        var result = CollectorValidator.validateCollectorResponse(json(document));
        compare(result.ok, false);
    }

    function test_rejectsStaleWithoutLastSuccessAt() {
        var document = Fixtures.minimalDocument({
            providers: [Fixtures.validStaleClaudeProvider({ lastSuccessAt: undefined })]
        });
        var result = CollectorValidator.validateCollectorResponse(json(document));
        compare(result.ok, false);
    }

    function test_rejectsStaleWithoutRetainedData() {
        var document = Fixtures.minimalDocument({
            providers: [Fixtures.validStaleClaudeProvider({ windows: [], details: undefined })]
        });
        var result = CollectorValidator.validateCollectorResponse(json(document));
        compare(result.ok, false);
    }

    function test_acceptsStaleWithRetainedDetailsOnly() {
        var document = Fixtures.minimalDocument({
            providers: [
                Fixtures.validStaleClaudeProvider({
                    windows: [],
                    details: { claude: { model: "synthetic-model" } }
                })
            ]
        });
        var result = CollectorValidator.validateCollectorResponse(json(document));
        compare(result.ok, true);
    }

    // --- Usage windows -------------------------------------------------------

    function test_rejectsInvalidWindowIdentifier() {
        var provider = Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ id: "!!bad!!" })] });
        var result = CollectorValidator.validateCollectorResponse(
            json(Fixtures.minimalDocument({ providers: [provider] }))
        );
        compare(result.ok, false);
    }

    function test_rejectsPercentOutOfRange() {
        var provider = Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 101 })] });
        var result = CollectorValidator.validateCollectorResponse(
            json(Fixtures.minimalDocument({ providers: [provider] }))
        );
        compare(result.ok, false);
    }

    function test_rejectsNegativeCount() {
        var provider = Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ used: -1 })] });
        var result = CollectorValidator.validateCollectorResponse(
            json(Fixtures.minimalDocument({ providers: [provider] }))
        );
        compare(result.ok, false);
    }

    function test_rejectsNonIntegerCount() {
        var provider = Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ used: 1.5 })] });
        var result = CollectorValidator.validateCollectorResponse(
            json(Fixtures.minimalDocument({ providers: [provider] }))
        );
        compare(result.ok, false);
    }

    function test_rejectsUsedExceedingLimit() {
        var provider = Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ used: 200, limit: 100 })] });
        var result = CollectorValidator.validateCollectorResponse(
            json(Fixtures.minimalDocument({ providers: [provider] }))
        );
        compare(result.ok, false);
    }

    function test_rejectsImpossibleZeroLimitPercent() {
        var provider = Fixtures.validClaudeProvider({
            windows: [Fixtures.validWindow({ limit: 0, usedPercent: 50, used: 0 })]
        });
        var result = CollectorValidator.validateCollectorResponse(
            json(Fixtures.minimalDocument({ providers: [provider] }))
        );
        compare(result.ok, false);
    }

    function test_rejectsUnknownWindowField() {
        var provider = Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ extra: true })] });
        var result = CollectorValidator.validateCollectorResponse(
            json(Fixtures.minimalDocument({ providers: [provider] }))
        );
        compare(result.ok, false);
    }

    // --- Provider-details namespace correlation --------------------------------

    function test_rejectsDetailsNamespaceMismatch() {
        var provider = Fixtures.validClaudeProvider({ details: { umans: { plan: "pro" } } });
        var result = CollectorValidator.validateCollectorResponse(
            json(Fixtures.minimalDocument({ providers: [provider] }))
        );
        compare(result.ok, false);
    }

    function test_rejectsUnknownDetailsField() {
        var provider = Fixtures.validClaudeProvider({ details: { claude: { madeUp: 1 } } });
        var result = CollectorValidator.validateCollectorResponse(
            json(Fixtures.minimalDocument({ providers: [provider] }))
        );
        compare(result.ok, false);
    }

    function test_rejectsMalformedDetailsShape() {
        var provider = Fixtures.validClaudeProvider({ details: { claude: { tokens: "not-a-count" } } });
        var result = CollectorValidator.validateCollectorResponse(
            json(Fixtures.minimalDocument({ providers: [provider] }))
        );
        compare(result.ok, false);
    }

    function test_acceptsUmansAndCodexDetailNamespaces() {
        var umans = Fixtures.validUmansProvider({
            state: "ok",
            lastSuccessAt: "2026-07-11T10:00:01.000Z",
            details: { umans: { plan: "pro", requests: 10 } }
        });
        var codex = Fixtures.validCodexProvider({
            state: "ok",
            lastSuccessAt: "2026-07-11T10:00:01.000Z",
            details: { codex: { plan: "plus", credits: 12.5, cost: 3.4 } }
        });
        var result = CollectorValidator.validateCollectorResponse(
            json(Fixtures.minimalDocument({ providers: [umans, codex] }))
        );
        compare(result.ok, true);
    }

    // --- No secret/raw-value diagnostics ---------------------------------------

    function test_failureCodesAreConstantStrings() {
        var codes = CollectorValidator.VALIDATION_FAILURE;
        for (var key in codes) {
            if (Object.prototype.hasOwnProperty.call(codes, key)) {
                compare(typeof codes[key], "string");
            }
        }
    }

    function test_failureNeverEchoesRejectedValue() {
        var secret = "sk-ant-shouldNeverAppearInAnyDiagnostic";
        var document = Fixtures.minimalDocument({
            providers: [Fixtures.validClaudeProvider({ status: secret })]
        });
        var result = CollectorValidator.validateCollectorResponse(json(document));
        compare(result.ok, false);
        verify(JSON.stringify(result).indexOf(secret) === -1);
    }
}
