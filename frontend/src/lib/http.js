export class ApiError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function readResponse(response) {
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, data?.error?.code ?? 'REQUEST_FAILED',
    data?.error?.message ?? 'Something went wrong. Please try again.', data?.error?.details);
  return data;
}

export function messageFor(error) {
  if (error instanceof ApiError) {
    if (error.details?.length) return error.details.map(item => `${item.field.split('.').at(-1)}: ${item.message}`).join(' · ');
    return error.message;
  }
  return 'We couldn’t connect. Please check your connection and try again.';
}
