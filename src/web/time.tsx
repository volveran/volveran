// A time as people read it, with the exact ISO 8601 on hover.
export const time = (iso: string) => <span title={iso}>{new Date(iso).toLocaleString()}</span>;
