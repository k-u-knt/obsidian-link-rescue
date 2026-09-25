// Dev helper for testing Link Rescue's iCloud handling on macOS.
//
//   swift scripts/icloud.swift status <file>...    show whether each file is local or only in iCloud
//   swift scripts/icloud.swift evict <file>...     remove the local copy (like Finder's "Remove Download")
//   swift scripts/icloud.swift download <file>...  ask iCloud to download it again
//
// Evicting only removes the local copy; the file stays in iCloud. Files that aren't fully uploaded
// yet are skipped, so nothing can be lost.
import Foundation

let args = CommandLine.arguments.dropFirst()
guard let command = args.first, ["status", "evict", "download"].contains(command), args.count > 1 else {
	print("usage: swift icloud.swift status|evict|download <file>...")
	exit(2)
}

let keys: Set<URLResourceKey> = [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey, .ubiquitousItemIsUploadedKey]
var failed = false

for path in args.dropFirst() {
	let url = URL(fileURLWithPath: path)
	let name = url.lastPathComponent
	do {
		let v = try url.resourceValues(forKeys: keys)
		guard v.isUbiquitousItem == true else {
			print("not in iCloud  \(name)")
			failed = true
			continue
		}
		let status = v.ubiquitousItemDownloadingStatus
		let local = status == .current || status == .downloaded
		switch command {
		case "status":
			print("\(local ? "local        " : "iCloud only  ")\(v.ubiquitousItemIsUploaded == true ? "" : "(not uploaded yet) ")\(name)")
		case "evict":
			guard v.ubiquitousItemIsUploaded == true else {
				print("skipped (not uploaded yet)  \(name)")
				continue
			}
			try FileManager.default.evictUbiquitousItem(at: url)
			print("evicted  \(name)")
		default:
			try FileManager.default.startDownloadingUbiquitousItem(at: url)
			print("downloading  \(name)")
		}
	} catch {
		print("error  \(name): \(error.localizedDescription)")
		failed = true
	}
}
exit(failed ? 1 : 0)
