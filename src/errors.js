// AppError + ERR catalogue — see plan-impl.md §4
export class AppError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

export const ERR = Object.freeze({
  INVALID_INPUT:      { status: 400, message: 'Invalid input.' },
  FORBIDDEN:          { status: 403, message: 'Only the host can do that.' },
  NOT_FOUND:          { status: 404, message: 'Session not found. Check the code.' },
  NAME_TAKEN:         { status: 409, message: 'That name is already taken in this session.' },
  ALREADY_DRAWN:      { status: 409, message: 'The draw has already happened.' },
  SESSION_FULL:       { status: 409, message: 'This session is full.' },
  TOO_FEW:            { status: 409, message: 'At least 3 participants are needed to draw.' },
  CANNOT_REMOVE_HOST: { status: 409, message: 'The host cannot be removed.' },
  UNKNOWN_PARTICIPANT:{ status: 404, message: 'No such participant.' },
  SESSION_LIMIT:      { status: 503, message: 'Too many active sessions. Try again later.' },
});

export const fail = (key, message) => { throw new AppError(key, message ?? ERR[key].message, ERR[key].status); };
