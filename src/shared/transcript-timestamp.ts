import type { TimestampDisplayMode } from "./pi-ui-config.ts";

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function formatTranscriptTimestamp(
	timestamp: number | string | undefined,
	mode: TimestampDisplayMode,
	now: Date = new Date(),
): string {
	if (mode === "off" || timestamp === undefined) return "";
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return "";
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	const time = `${hours}:${minutes}`;
	if (mode === "time") return time;
	const year = date.getFullYear();
	const month = SHORT_MONTHS[date.getMonth()];
	return `${date.getDate()} ${month}${year === now.getFullYear() ? "" : ` ${year}`}, ${time}`;
}
