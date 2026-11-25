export interface TestAntiMockViolation {
	line: number;
	message: string;
}

export function findSingleLineCommentLines(sourceText: string): number[];
export function findTestAntiMockViolations(
	sourceText: string,
	options?: { isPureUnit?: boolean },
): TestAntiMockViolation[];
export function validateCommitMessage(rawMessage: string): string[];
export function checkRepositoryStandards(rootDir?: string): string[];
