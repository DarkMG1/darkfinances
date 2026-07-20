export async function runStaleRefetch(
  refetch?: () => void | boolean | Promise<boolean | void | unknown>,
): Promise<boolean> {
  try {
    const result = await refetch?.();
    if (result && typeof result === 'object' && 'isError' in result) {
      return result.isError !== true;
    }
    return result !== false;
  } catch {
    return false;
  }
}

export function staleConflictNotice(summary: string): string {
  return `${summary} Latest server data is shown below — review your edits and try again.`;
}
