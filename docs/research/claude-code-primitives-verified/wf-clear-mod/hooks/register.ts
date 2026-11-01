import type { Register } from 'claude-code'

export const register: Register = (on) => {
  on('session.receive', ($, e, next) => {
    if (e.text.includes('__WF_CLEAR__')) {
      void $.command.run({ command: 'clear' })
      return { consumed: 'wf-clear: lead asked for /clear' }
    }
    return next(e)
  })
}
