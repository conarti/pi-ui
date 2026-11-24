import { randomUUID } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convertToPng } from "@earendil-works/pi-coding-agent";
import { getImageDimensions } from "@earendil-works/pi-tui";
import {
	sniffSupportedImageMimeType,
	type ClipboardImagePayload,
} from "../../shared/host-runtime.ts";
import { decodeBracketedPasteControlSequences, type RegisterImageChipInput } from "./registry.ts";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const DIRECT_SUPPORTED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function extensionForImageMime(mimeType: string): string {
	switch (mimeType.split(";")[0]?.trim().toLowerCase()) {
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		case "image/png":
		default:
			return "png";
	}
}

export function normalizeCandidateImagePath(rawToken: string, cwd: string): string | undefined {
	let candidate = rawToken.trim();
	if (!candidate || candidate.length > 4096 || /\p{Cc}/u.test(candidate)) {
		return undefined;
	}

	if (candidate.startsWith("@") && candidate.length > 1) {
		candidate = candidate.slice(1).trim();
	}

	if (
		(candidate.startsWith("'") && candidate.endsWith("'") && candidate.length >= 2) ||
		(candidate.startsWith('"') && candidate.endsWith('"') && candidate.length >= 2)
	) {
		candidate = candidate.slice(1, -1);
	} else if (process.platform !== "win32" && candidate.includes("\\")) {
		candidate = candidate.replace(/\\([ ()[\]{}'"&;!#$`~])/g, "$1");
	}

	if (candidate.startsWith("file://")) {
		try {
			candidate = fileURLToPath(candidate);
		} catch {
			return undefined;
		}
	} else if (candidate === "~" || candidate.startsWith("~/")) {
		candidate = join(homedir(), candidate.slice(1));
	}

	const ext = extname(candidate).toLowerCase();
	if (!IMAGE_EXTENSIONS.has(ext)) {
		return undefined;
	}

	return isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
}

function readBmpDimensions(bytes: Uint8Array): { widthPx: number; heightPx: number } | null {
	if (bytes.byteLength < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
		return null;
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const dibHeaderSize = view.getUint32(14, true);
	let widthPx = 0;
	let heightPx = 0;
	if (dibHeaderSize === 12) {
		widthPx = view.getUint16(18, true);
		heightPx = view.getUint16(20, true);
	} else if (dibHeaderSize >= 16) {
		widthPx = Math.abs(view.getInt32(18, true));
		heightPx = Math.abs(view.getInt32(22, true));
	}
	return widthPx > 0 && heightPx > 0 ? { widthPx, heightPx } : null;
}

export function tryReadImageFileSync(
	rawPath: string,
	cwd: string,
): RegisterImageChipInput | undefined {
	const resolvedPath = normalizeCandidateImagePath(rawPath, cwd);
	if (!resolvedPath) return undefined;

	try {
		const stat = statSync(resolvedPath);
		if (!stat.isFile() || stat.size <= 0) return undefined;
		const bytes = readFileSync(resolvedPath);
		const mimeType = sniffSupportedImageMimeType(bytes);
		if (!mimeType) return undefined;
		const base64Data = bytes.toString("base64");
		const dims = DIRECT_SUPPORTED_IMAGE_MIMES.has(mimeType)
			? getImageDimensions(base64Data, mimeType)
			: mimeType === "image/bmp"
				? readBmpDimensions(bytes)
				: null;
		return {
			filePath: resolvedPath,
			fileName: basename(resolvedPath),
			mimeType,
			byteLength: bytes.byteLength,
			base64Data,
			widthPx: dims?.widthPx,
			heightPx: dims?.heightPx,
		};
	} catch {
		return undefined;
	}
}

export function extractPastedImageFilesSync(
	rawPasteText: string,
	cwd: string,
): RegisterImageChipInput[] | undefined {
	const decoded = decodeBracketedPasteControlSequences(rawPasteText)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.trim();
	if (!decoded) return undefined;

	const rawLines = decoded
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (rawLines.length === 0 || rawLines.length > 16) {
		return undefined;
	}

	const found: RegisterImageChipInput[] = [];
	for (const line of rawLines) {
		const img = tryReadImageFileSync(line, cwd);
		if (!img) {
			return undefined;
		}
		found.push(img);
	}
	return found.length > 0 ? found : undefined;
}

export async function materializeClipboardImagePayload(
	payload: ClipboardImagePayload,
): Promise<RegisterImageChipInput | null> {
	if (!payload.bytes || payload.bytes.length === 0) return null;

	let bytes = payload.bytes;
	let mimeType =
		sniffSupportedImageMimeType(bytes) ??
		payload.mimeType.split(";")[0]?.trim().toLowerCase() ??
		"image/png";

	if (!DIRECT_SUPPORTED_IMAGE_MIMES.has(mimeType)) {
		try {
			const b64 = Buffer.from(bytes).toString("base64");
			const converted = await convertToPng(b64, mimeType);
			if (!converted?.data) return null;
			bytes = new Uint8Array(Buffer.from(converted.data, "base64"));
			mimeType = "image/png";
		} catch {
			return null;
		}
	}

	const ext = extensionForImageMime(mimeType);
	const fileName = payload.fileName || (payload.filePath ? basename(payload.filePath) : `pi-clipboard-${randomUUID()}.${ext}`);
	const filePath = payload.filePath || join(tmpdir(), fileName);

	if (!payload.filePath) {
		writeFileSync(filePath, Buffer.from(bytes));
	}

	const base64Data = Buffer.from(bytes).toString("base64");
	const dims = getImageDimensions(base64Data, mimeType);

	return {
		filePath,
		fileName,
		mimeType,
		byteLength: bytes.byteLength,
		base64Data,
		widthPx: dims?.widthPx,
		heightPx: dims?.heightPx,
	};
}
