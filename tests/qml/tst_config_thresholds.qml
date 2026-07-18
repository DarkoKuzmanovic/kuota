import QtQuick
import QtTest

TestCase {
    name: "ConfigThresholds"
    visible: true

    Component {
        id: pageComponent
        Loader {
            source: "../../plasmoid/contents/ui/configThresholds.qml"
        }
    }

    function findChildByObjectName(parent, name) {
        if (!parent || !parent.children) {
            return null;
        }
        for (var i = 0; i < parent.children.length; i++) {
            var child = parent.children[i];
            if (child.objectName === name) {
                return child;
            }
            var found = findChildByObjectName(child, name);
            if (found !== null) {
                return found;
            }
        }
        return null;
    }

    function test_cautionAboveCriticalAdjustsCritical() {
        var loader = pageComponent.createObject(null);
        tryCompare(loader, "status", Loader.Ready);
        var page = loader.item;
        verify(page !== null);

        page.cfg_cautionThreshold = 95;
        var cautionSpin = findChildByObjectName(page, "cautionThresholdSpin");
        verify(cautionSpin !== null);
        cautionSpin.valueModified();
        compare(page.cfg_criticalThreshold, 96);

        loader.destroy();
    }

    function test_criticalBelowCautionAdjustsCaution() {
        var loader = pageComponent.createObject(null);
        tryCompare(loader, "status", Loader.Ready);
        var page = loader.item;
        verify(page !== null);

        // Start from a valid default pair (as KConfig would), then lower critical.
        page.cfg_cautionThreshold = 75;
        page.cfg_criticalThreshold = 90;
        page.cfg_criticalThreshold = 20;
        var criticalSpin = findChildByObjectName(page, "criticalThresholdSpin");
        verify(criticalSpin !== null);
        criticalSpin.valueModified();
        compare(page.cfg_cautionThreshold, 19);

        loader.destroy();
    }

    function test_equalValuesAreAdjustedToMaintainOrder() {
        var loader = pageComponent.createObject(null);
        tryCompare(loader, "status", Loader.Ready);
        var page = loader.item;
        verify(page !== null);

        page.cfg_cautionThreshold = 50;
        page.cfg_criticalThreshold = 50;
        var cautionSpin = findChildByObjectName(page, "cautionThresholdSpin");
        var criticalSpin = findChildByObjectName(page, "criticalThresholdSpin");
        verify(cautionSpin !== null && criticalSpin !== null);
        cautionSpin.valueModified();
        criticalSpin.valueModified();
        verify(page.cfg_cautionThreshold < page.cfg_criticalThreshold);

        loader.destroy();
    }

    function test_validPairIsNotAdjusted() {
        var loader = pageComponent.createObject(null);
        tryCompare(loader, "status", Loader.Ready);
        var page = loader.item;
        verify(page !== null);

        page.cfg_cautionThreshold = 60;
        page.cfg_criticalThreshold = 85;
        var cautionSpin = findChildByObjectName(page, "cautionThresholdSpin");
        var criticalSpin = findChildByObjectName(page, "criticalThresholdSpin");
        verify(cautionSpin !== null && criticalSpin !== null);
        cautionSpin.valueModified();
        criticalSpin.valueModified();
        compare(page.cfg_cautionThreshold, 60);
        compare(page.cfg_criticalThreshold, 85);

        loader.destroy();
    }
}
