import QtQuick
import org.kde.plasma.plasmoid 2.1
import org.kde.kirigami 2.20 as Kirigami

PlasmoidItem {
    id: root

    compactRepresentation: Kirigami.Icon {
        source: "network-server"
    }

    fullRepresentation: Kirigami.ScrollablePage {
        Kirigami.PlaceholderMessage {
            anchors.centerIn: parent
            text: "Kuota"
        }
    }
}
