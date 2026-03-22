/**
 * Get the display-friendly file path from a diff file entry.
 * Prefers newPath unless the file was deleted (/dev/null).
 */
export function getFilePath(file: { oldPath: string; newPath: string }): string {
	if (file.newPath && file.newPath !== '/dev/null') return file.newPath;
	return file.oldPath;
}
