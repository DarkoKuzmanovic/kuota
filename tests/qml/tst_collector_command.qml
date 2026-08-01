import QtQuick
import QtTest

import "../../plasmoid/contents/ui/collector-command.js" as CollectorCommand

TestCase {
    name: "CollectorCommand"

    property string samplePath: "/opt/kuota/contents/code/collector/cli.js"

    function test_exposesFixedNodePathConstant() {
        compare(CollectorCommand.NODE_PATH, "/usr/bin/node");
    }

    function test_exposesCanonicalProviderIdsInOrder() {
        compare(CollectorCommand.CANONICAL_PROVIDER_IDS.length, 4);
        compare(CollectorCommand.CANONICAL_PROVIDER_IDS[0], "claude");
        compare(CollectorCommand.CANONICAL_PROVIDER_IDS[1], "codex");
        compare(CollectorCommand.CANONICAL_PROVIDER_IDS[2], "grok");
        compare(CollectorCommand.CANONICAL_PROVIDER_IDS[3], "kimi");
    }

    // --- Defaults / providers omitted ---------------------------------

    function test_buildsFixedNodePathAndQuotedPathWithoutProviderFlagForUndefinedProviders() {
        var result = CollectorCommand.buildCollectorCommand({
            collectorPath: samplePath,
            enabledProviders: undefined,
            sourceId: 1
        });
        compare(result.ok, true);
        compare(result.value, "/usr/bin/node '" + samplePath + "' # 1");
    }

    function test_omitsProviderFlagWhenProvidersIsNull() {
        var result = CollectorCommand.buildCollectorCommand({
            collectorPath: samplePath,
            enabledProviders: null,
            sourceId: 7
        });
        compare(result.ok, true);
        compare(result.value.indexOf("--enabled-providers="), -1);
        verify(result.value.indexOf("# 7") !== -1);
    }

    // --- Canonical / empty provider sets -------------------------------

    function test_buildsCanonicalProviderFlagRegardlessOfInputOrder() {
        var result = CollectorCommand.buildCollectorCommand({
            collectorPath: samplePath,
            enabledProviders: ["codex", "claude"],
            sourceId: 2
        });
        compare(result.ok, true);
        compare(result.value, "/usr/bin/node '" + samplePath + "' --enabled-providers=claude,codex # 2");
    }

    function test_buildsFullCanonicalSetInCanonicalOrder() {
        var result = CollectorCommand.buildCollectorCommand({
            collectorPath: samplePath,
            enabledProviders: ["kimi", "codex", "claude", "grok"],
            sourceId: 3
        });
        compare(result.ok, true);
        compare(result.value, "/usr/bin/node '" + samplePath + "' --enabled-providers=claude,codex,grok,kimi # 3");
    }

    function test_silentlySkipsUmansInProviderList() {
        var result = CollectorCommand.buildCollectorCommand({
            collectorPath: samplePath,
            enabledProviders: ["umans", "codex", "claude"],
            sourceId: 13
        });
        compare(result.ok, true);
        compare(result.value, "/usr/bin/node '" + samplePath + "' --enabled-providers=claude,codex # 13");
    }

    function test_buildsEmptyProviderFlagForEmptyArray() {
        var result = CollectorCommand.buildCollectorCommand({
            collectorPath: samplePath,
            enabledProviders: [],
            sourceId: 4
        });
        compare(result.ok, true);
        compare(result.value, "/usr/bin/node '" + samplePath + "' --enabled-providers= # 4");
    }

    // --- Rejection of unsafe / hostile provider input ------------------

    function test_rejectsDuplicateProviders() {
        var result = CollectorCommand.buildCollectorCommand({
            collectorPath: samplePath,
            enabledProviders: ["claude", "claude"],
            sourceId: 5
        });
        compare(result.ok, false);
        compare(result.code, CollectorCommand.COMMAND_BUILD_FAILURE.INVALID_PROVIDER_LIST);
    }

    function test_rejectsUnknownProviderId() {
        var result = CollectorCommand.buildCollectorCommand({
            collectorPath: samplePath,
            enabledProviders: ["claude", "gemini"],
            sourceId: 5
        });
        compare(result.ok, false);
        compare(result.code, CollectorCommand.COMMAND_BUILD_FAILURE.INVALID_PROVIDER_LIST);
    }

    function test_rejectsNonArrayProviderList() {
        var hostileValues = ["claude", 42, {}, true];
        for (var i = 0; i < hostileValues.length; i++) {
            var result = CollectorCommand.buildCollectorCommand({
                collectorPath: samplePath,
                enabledProviders: hostileValues[i],
                sourceId: 5
            });
            compare(result.ok, false);
            compare(result.code, CollectorCommand.COMMAND_BUILD_FAILURE.INVALID_PROVIDER_LIST);
        }
    }

    function test_rejectsNonStringProviderEntries() {
        var result = CollectorCommand.buildCollectorCommand({
            collectorPath: samplePath,
            enabledProviders: ["claude", 1],
            sourceId: 5
        });
        compare(result.ok, false);
        compare(result.code, CollectorCommand.COMMAND_BUILD_FAILURE.INVALID_PROVIDER_LIST);
    }

    // --- Quoting / injection safety on the collector path ---------------

    function test_quotesApostrophesSafely() {
        var path = "/opt/kuota's dir/cli.js";
        var result = CollectorCommand.buildCollectorCommand({
            collectorPath: path,
            enabledProviders: undefined,
            sourceId: 8
        });
        compare(result.ok, true);
        compare(result.value, "/usr/bin/node '/opt/kuota'\\''s dir/cli.js' # 8");
    }

    function test_quotesSpacesDollarBackticksSemicolonsSafely() {
        var path = "/opt/kuota dir/$(rm -rf ~)`touch pwn`;evil.js";
        var result = CollectorCommand.buildCollectorCommand({
            collectorPath: path,
            enabledProviders: undefined,
            sourceId: 9
        });
        compare(result.ok, true);
        // The entire hostile path must be wrapped in one single-quoted
        // literal with no unescaped quote boundary, so none of the shell
        // metacharacters inside can be interpreted.
        compare(result.value, "/usr/bin/node '" + path + "' # 9");
    }

    function test_rejectsNewlineInPath() {
        var result = CollectorCommand.buildCollectorCommand({
            collectorPath: "/opt/kuota/cli.js\nrm -rf ~",
            enabledProviders: undefined,
            sourceId: 10
        });
        compare(result.ok, false);
        compare(result.code, CollectorCommand.COMMAND_BUILD_FAILURE.INVALID_COLLECTOR_PATH);
    }

    function test_rejectsControlCharactersInPath() {
        var hostilePaths = [
            "/opt/kuota/\u0000cli.js",
            "/opt/kuota/\u0007cli.js",
            "/opt/kuota/\u001bcli.js",
            "/opt/kuota/\u007fcli.js"
        ];
        for (var i = 0; i < hostilePaths.length; i++) {
            var result = CollectorCommand.buildCollectorCommand({
                collectorPath: hostilePaths[i],
                enabledProviders: undefined,
                sourceId: 10
            });
            compare(result.ok, false);
            compare(result.code, CollectorCommand.COMMAND_BUILD_FAILURE.INVALID_COLLECTOR_PATH);
        }
    }

    function test_rejectsEmptyPath() {
        var result = CollectorCommand.buildCollectorCommand({
            collectorPath: "",
            enabledProviders: undefined,
            sourceId: 10
        });
        compare(result.ok, false);
        compare(result.code, CollectorCommand.COMMAND_BUILD_FAILURE.INVALID_COLLECTOR_PATH);
    }

    function test_rejectsNonStringPath() {
        var hostileValues = [null, undefined, 42, {}, []];
        for (var i = 0; i < hostileValues.length; i++) {
            var result = CollectorCommand.buildCollectorCommand({
                collectorPath: hostileValues[i],
                enabledProviders: undefined,
                sourceId: 10
            });
            compare(result.ok, false);
            compare(result.code, CollectorCommand.COMMAND_BUILD_FAILURE.INVALID_COLLECTOR_PATH);
        }
    }

    function test_rejectsOverlongPath() {
        var overlong = "/" + new Array(4098).join("a");
        var result = CollectorCommand.buildCollectorCommand({
            collectorPath: overlong,
            enabledProviders: undefined,
            sourceId: 10
        });
        compare(result.ok, false);
        compare(result.code, CollectorCommand.COMMAND_BUILD_FAILURE.INVALID_COLLECTOR_PATH);
    }

    // --- Source identity -------------------------------------------------

    function test_sourceSuffixIsIntegerOnlyAndUnique() {
        var first = CollectorCommand.buildCollectorCommand({
            collectorPath: samplePath,
            enabledProviders: undefined,
            sourceId: 11
        });
        var second = CollectorCommand.buildCollectorCommand({
            collectorPath: samplePath,
            enabledProviders: undefined,
            sourceId: 12
        });
        compare(first.ok, true);
        compare(second.ok, true);
        verify(first.value !== second.value);
        verify(/ # \d+$/.test(first.value));
        verify(/ # \d+$/.test(second.value));
    }

    function test_rejectsNonIntegerSourceId() {
        var hostileValues = [1.5, "1", NaN, Infinity, -1, null, undefined, {}];
        for (var i = 0; i < hostileValues.length; i++) {
            var result = CollectorCommand.buildCollectorCommand({
                collectorPath: samplePath,
                enabledProviders: undefined,
                sourceId: hostileValues[i]
            });
            compare(result.ok, false);
            compare(result.code, CollectorCommand.COMMAND_BUILD_FAILURE.INVALID_SOURCE_ID);
        }
    }

    // --- Total hostile-input safety -------------------------------------

    function test_neverThrowsForHostileOptions() {
        var hostileOptions = [null, undefined, 42, "options", [], true];
        for (var i = 0; i < hostileOptions.length; i++) {
            var result = CollectorCommand.buildCollectorCommand(hostileOptions[i]);
            verify(result.ok === false || result.ok === true);
        }
    }
}
