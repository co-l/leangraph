export function isValidPropertyValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;

  if (typeof value === "string") return true;
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);

  if (Array.isArray(value)) {
    return value.every((item) => {
      if (item === null || item === undefined) return false;
      if (typeof item === "string") return true;
      if (typeof item === "boolean") return true;
      if (typeof item === "number") return Number.isFinite(item);
      return false;
    });
  }

  return false;
}

export function assertValidPropertyValue(value: unknown): void {
  if (!isValidPropertyValue(value)) {
    throw new Error("TypeError: InvalidPropertyType");
  }
}

