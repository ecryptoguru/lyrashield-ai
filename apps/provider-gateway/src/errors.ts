export class ProviderGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 403
  ) {
    super(message)
    this.name = "ProviderGatewayError"
  }
}
