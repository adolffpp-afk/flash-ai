// Flash's own Android app (android/), a Trusted Web Activity that opens www.flash-app.dev full screen.
// Android shows it without a browser bar only when /.well-known/assetlinks.json lists the
// app's signing certificate. Only Flash's own app belongs here, never a user's built app.
export const ANDROID_PACKAGE = "dev.flashapp.ai";

// SHA-256 of each certificate that signs the app: the upload key (for the .apk people install by
// hand), then the Play app-signing key from Play Console > Test and release > App integrity
// once Google shows it.
export const ANDROID_CERT_SHA256 = [
  "19:03:EC:32:59:E9:12:B9:5B:F5:9B:8B:A1:EE:F7:57:C3:1E:CE:90:19:BC:FC:1C:A4:F5:39:F7:82:35:7D:0E",
  // Play app-signing key: Play re-signs the copies it ships
  "DE:3F:31:71:73:15:57:2F:CA:4B:00:E5:A1:B9:75:D3:6B:BB:B6:2F:34:DF:F5:D4:95:36:B5:EB:01:15:1C:D8",
];

export function assetLinks() {
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: ANDROID_CERT_SHA256 },
    },
  ];
}
