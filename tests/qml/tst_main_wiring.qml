import QtQuick
import QtTest

TestCase {
    name: "MainWiring"
    when: windowShown

    Component {
        id: mainComponent
        Loader {
            source: "../../plasmoid/contents/ui/main.qml"
        }
    }

    function test_exposesOnlyTheSafeRootRefreshLifecycleSurface() {
        var loader = mainComponent.createObject(null);
        tryCompare(loader, "status", Loader.Ready);
        var root = loader.item;

        compare(typeof root.refresh, "function");
        compare(typeof root.inFlight, "boolean");
        compare(typeof root.lifecycleStatus, "string");
        compare(typeof root.snapshotAgeMs, "function");
        // No snapshot has been accepted yet at first load.
        compare(root.snapshot, null);

        loader.destroy();
    }
}
