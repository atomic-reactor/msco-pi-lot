function maskLongValue(value: string): string {
  if (value.length <= 10) {
    return "*".repeat(value.length);
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function maskSecret(value: string): string {
  return value ? maskLongValue(value) : "";
}

export function maskCookie(value: string): string {
  if (!value) {
    return "";
  }

  return value.replace(/=([^;]+)/g, "=***");
}
