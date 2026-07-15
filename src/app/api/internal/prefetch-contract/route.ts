const rejection = {
  error: {
    code: "INVALID_PREFETCH_CONTRACT",
    message: "Invalid router prefetch request.",
  },
};

export function GET() {
  return Response.json(rejection, {
    status: 400,
    headers: { "Cache-Control": "private, no-store" },
  });
}
