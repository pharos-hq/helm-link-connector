const OPERATIONAL = /\b(build|implement|deploy|publish|install|configure|migrate|execute|run\s+(?:a|the|this|command|script)|write\s+(?:a|the|this|file|code)|edit\s+(?:a|the|this|file|code)|research\s+and|send\s+(?:an?\s+)?(?:email|message)|create\s+(?:a\s+)?(?:pr|branch|file|document)|use\s+(?:the\s+)?(?:terminal|shell|browser|tool))\b/i

export function classifyWorkloadText(text) {
  const value = String(text || '').trim()
  if (!value) return { lane: 'reject', reason: 'empty' }
  if (OPERATIONAL.test(value)) return { lane: 'run', reason: 'operational-intent' }
  return { lane: 'chat', reason: 'advisory' }
}

export function validateRunContract(contract) {
  if (!contract || contract.kind !== 'run') throw new Error('Durable Run contract is required.')
  if (!Array.isArray(contract.capabilities) || contract.capabilities.length === 0) {
    throw new Error('Run capabilities are required.')
  }
  const deadlineMs = Number(contract.deadlineMs)
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 30_000 || deadlineMs > 3_600_000) {
    throw new Error('Run deadline must be between 30 seconds and 1 hour.')
  }
  if (contract.cancellation !== 'terminal-no-replay') throw new Error('Run cancellation must be terminal-no-replay.')
  return { ...contract, deadlineMs }
}
