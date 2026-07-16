import QtQuick
import QtTest

TestCase {
    name: "ModuleIsolation"

    property var forbiddenPatterns: [
        "org.kde.plasma.",
        "plasma5support",
        "datasource",
        "child_process",
        "require(",
        "qt.labs.settings",
        "xmlhttprequest",
        "process.env",
        "process.argv",
        "process.exit"
    ]

    property var modulesUnderTest: [
        "../../plasmoid/contents/ui/collector-validator.js",
        "../../plasmoid/contents/ui/snapshot-state.js",
        "../../plasmoid/contents/ui/collector-command.js",
        "../../plasmoid/contents/ui/bridge-lifecycle.js",
        "../../plasmoid/contents/ui/compact-model.js",
        "../../plasmoid/contents/ui/full-model.js"
    ]

    // Every production QML file that could plausibly import the executable
    // compatibility bridge. Exactly one is allowed to.
    property var productionQmlFiles: [
        "../../plasmoid/contents/ui/main.qml",
        "../../plasmoid/contents/ui/CompactRepresentation.qml",
        "../../plasmoid/contents/ui/FullRepresentation.qml",
        "../../plasmoid/contents/ui/CollectorBridge.qml"
    ]
    property string executableBridgeImport: "org.kde.plasma.plasma5support"

    function readLocalFile(relativePath) {
        var request = new XMLHttpRequest();
        request.open("GET", Qt.resolvedUrl(relativePath), false);
        request.send(null);
        if (request.status !== 0 && request.status !== 200) {
            fail("could not read module source for isolation scan: " + relativePath);
        }
        return request.responseText;
    }

    function test_modulesContainNoForbiddenPlasmaOrProcessReferences() {
        for (var m = 0; m < modulesUnderTest.length; m++) {
            var source = readLocalFile(modulesUnderTest[m]).toLowerCase();
            verify(source.length > 0);
            for (var p = 0; p < forbiddenPatterns.length; p++) {
                var found = source.indexOf(forbiddenPatterns[p]) !== -1;
                verify(!found, modulesUnderTest[m] + " must not reference '" + forbiddenPatterns[p] + "'");
            }
        }
    }

    function test_modulesDeclareThemselvesAsPragmaLibraries() {
        for (var m = 0; m < modulesUnderTest.length; m++) {
            var source = readLocalFile(modulesUnderTest[m]);
            verify(source.indexOf(".pragma library") === 0, modulesUnderTest[m] + " must be a pure pragma-library script");
        }
    }

    function test_exactlyOneProductionQmlFileImportsTheExecutableBridge() {
        var importingFiles = [];
        for (var f = 0; f < productionQmlFiles.length; f++) {
            var source = readLocalFile(productionQmlFiles[f]);
            var occurrences = source.split(executableBridgeImport).length - 1;
            verify(occurrences <= 1, productionQmlFiles[f] + " must import the executable bridge at most once");
            if (occurrences === 1) {
                importingFiles.push(productionQmlFiles[f]);
            }
        }
        compare(importingFiles.length, 1);
        compare(importingFiles[0], "../../plasmoid/contents/ui/CollectorBridge.qml");
    }
}
