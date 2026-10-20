// Newbro's macOS helper for signing in with a passkey from a phone (hybrid /
// caBLE v2; the protocol itself lives in src/main/hybrid.ts).
//
//   newbro-hybrid qr <text>   prints the QR code for <text> as a base64 PNG,
//                              one pixel per module
//   newbro-hybrid scan        scans Bluetooth LE and prints one line per event:
//                                state on|off|unauthorized|unsupported|unknown
//                                advert <40 hex chars>   (FIDO hybrid service data)
//                              until stdin closes
//
// Node has no Bluetooth, so main runs this next to the ceremony. Built by
// scripts/build-native.mjs.

import CoreBluetooth
import CoreImage
import Foundation
import ImageIO

func emit(_ line: String) {
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

func qr(_ text: String) {
    guard let filter = CIFilter(name: "CIQRCodeGenerator") else { fail("no QR generator") }
    filter.setValue(Data(text.utf8), forKey: "inputMessage")
    filter.setValue("M", forKey: "inputCorrectionLevel")
    guard let image = filter.outputImage,
          let cgImage = CIContext().createCGImage(image, from: image.extent) else { fail("QR rendering failed") }
    let png = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(png, "public.png" as CFString, 1, nil) else {
        fail("PNG encoder unavailable")
    }
    CGImageDestinationAddImage(destination, cgImage, nil)
    guard CGImageDestinationFinalize(destination) else { fail("PNG encoding failed") }
    emit((png as Data).base64EncodedString())
}

final class Scanner: NSObject, CBCentralManagerDelegate {
    // FIDO's hybrid UUID, and Google's that early phones used.
    private let services = [CBUUID(string: "FFF9"), CBUUID(string: "FDE2")]
    private var central: CBCentralManager?

    func start() {
        central = CBCentralManager(delegate: self, queue: nil)
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            emit("state on")
            // Unfiltered: a phone may put the UUID only in its service data.
            central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
        case .poweredOff: emit("state off")
        case .unauthorized: emit("state unauthorized")
        case .unsupported: emit("state unsupported")
        default: emit("state unknown")
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard let serviceData = advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data] else { return }
        for uuid in services {
            if let data = serviceData[uuid], data.count == 20 {
                emit("advert " + data.map { String(format: "%02x", $0) }.joined())
            }
        }
    }
}

let arguments = CommandLine.arguments
switch arguments.count > 1 ? arguments[1] : "" {
case "qr":
    guard arguments.count > 2 else { fail("usage: newbro-hybrid qr <text>") }
    qr(arguments[2])
case "scan":
    let scanner = Scanner()
    scanner.start()
    // Main closes stdin when the ceremony ends (or dies): stop with it.
    Thread.detachNewThread {
        while readLine() != nil {}
        exit(0)
    }
    RunLoop.main.run()
default:
    fail("usage: newbro-hybrid qr <text> | scan")
}
