// An error from a model provider, already mapped to an HTTP status and a user-facing message.
export class ModelError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}
