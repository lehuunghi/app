import UIKit
import AVFoundation
import Capacitor

@objc(QrLoginScannerPlugin)
public class QrLoginScannerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "QrLoginScannerPlugin"
    public let jsName = "QrLoginScanner"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise)]
    private var scanning = false
    @objc func scan(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard !self.scanning else { call.reject("Scanner already open", "busy"); return }
            self.scanning = true
            let present = { (allowed: Bool) in
                DispatchQueue.main.async {
                    guard allowed, let host = self.bridge?.viewController else {
                        self.scanning = false; call.reject("Camera access required", "camera_denied"); return
                    }
                    let scanner = LoginQrCamera()
                    scanner.completed = { value, code in
                        self.scanning = false
                        if let value = value { call.resolve(["value": value]) }
                        else { call.reject("Scan did not complete", code ?? "scan_failed") }
                    }
                    let navigation = UINavigationController(rootViewController: scanner)
                    navigation.modalPresentationStyle = .fullScreen
                    navigation.isModalInPresentation = true
                    host.present(navigation, animated: true)
                }
            }
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: present(true)
            case .notDetermined: AVCaptureDevice.requestAccess(for: .video, completionHandler: present)
            default: present(false)
            }
        }
    }
}

private class LoginQrCamera: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var completed: ((String?, String?) -> Void)?
    private let capture = AVCaptureSession()
    private let queue = DispatchQueue(label: "webmail.qr.camera")
    private var preview: AVCaptureVideoPreviewLayer?
    private var finished = false
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        title = "Quét QR đăng nhập webmail"
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Hủy", style: .plain, target: self, action: #selector(cancel))
        let preview = AVCaptureVideoPreviewLayer(session: capture)
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview); self.preview = preview
        queue.async {
            do {
                guard let device = AVCaptureDevice.default(for: .video) else { throw CameraError.unavailable }
                let input = try AVCaptureDeviceInput(device: device)
                let output = AVCaptureMetadataOutput()
                self.capture.beginConfiguration()
                guard self.capture.canAddInput(input), self.capture.canAddOutput(output) else {
                    self.capture.commitConfiguration(); throw CameraError.unavailable
                }
                self.capture.addInput(input); self.capture.addOutput(output)
                output.setMetadataObjectsDelegate(self, queue: .main)
                guard output.availableMetadataObjectTypes.contains(.qr) else {
                    self.capture.commitConfiguration(); throw CameraError.unavailable
                }
                output.metadataObjectTypes = [.qr]
                self.capture.commitConfiguration()
                self.capture.startRunning()
            } catch { DispatchQueue.main.async { self.finish(nil, "scan_failed") } }
        }
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); preview?.frame = view.bounds }
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        queue.async { if self.capture.isRunning { self.capture.stopRunning() } }
        if !finished { finish(nil, "cancelled") }
    }
    @objc private func cancel() { finish(nil, "cancelled") }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        if let value = objects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first { finish(value, nil) }
    }
    private func finish(_ value: String?, _ code: String?) {
        guard !finished else { return }; finished = true
        queue.async { if self.capture.isRunning { self.capture.stopRunning() } }
        dismiss(animated: true) { self.completed?(value, code); self.completed = nil }
    }
    private enum CameraError: Error { case unavailable }
}
