import QtQuick
import org.kde.plasma.configuration

ConfigModel {
    ConfigCategory {
        name: i18n("Appearance")
        icon: "preferences-desktop-display"
        source: "configAppearance.qml"
    }
    ConfigCategory {
        name: i18n("Theming")
        icon: "preferences-desktop-color"
        source: "configTheming.qml"
    }
    ConfigCategory {
        name: i18n("Providers")
        icon: "network-server"
        source: "configProviders.qml"
    }
    ConfigCategory {
        name: i18n("Thresholds & Refresh")
        icon: "preferences-system"
        source: "configThresholds.qml"
    }
}
