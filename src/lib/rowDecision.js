export const rowHints = {
  step1:
    'FIE t.56: The attack is the initial offensive action made by extending the arm and continuously threatening target.',
  step2: 'FIE t.56/t.75: If the attack lands validly without a successful parry, priority remains with attacker.',
  step3: 'FIE t.84: A successful parry transfers right-of-way to the defender.',
  step4: 'FIE t.89: The riposte must be immediate; delay can lose priority and allow remise.',
}

export function evaluateRow(weapon, answers) {
  if (weapon === 'epee') {
    if (answers.epeeDoubleTouch) return { scorer: 'none', verdict: 'DOUBLE TOUCH (ÉPÉE)' }
    return { scorer: answers.epeeScorer || 'none', verdict: `ÉPÉE TOUCH: ${answers.epeeScorer || 'none'}` }
  }

  if (answers.step1AttackEstablished === 'no') {
    if (answers.step1BothLights === 'yes') return { scorer: 'none', verdict: 'SIMULTANEOUS' }
    return { scorer: answers.step1SingleLightScorer || 'none', verdict: 'NO ATTACK ESTABLISHED' }
  }

  if (answers.step1Initiator === 'both') {
    return { scorer: 'none', verdict: 'SIMULTANEOUS' }
  }

  const attacker = answers.step1Initiator
  const defender = attacker === 'left' ? 'right' : 'left'

  if (answers.step2LandedNoParry === 'yes') {
    return { scorer: attacker, verdict: `POINT ${attacker.toUpperCase()} (INITIAL ATTACK)` }
  }

  if (answers.step3SuccessfulParry === 'yes') {
    if (answers.step4RiposteImmediate === 'yes') {
      return { scorer: defender, verdict: `POINT ${defender.toUpperCase()} (PARRY-RIPOSTE)` }
    }

    if (answers.step4OriginalAttackerRemise === 'yes') {
      return { scorer: attacker, verdict: `POINT ${attacker.toUpperCase()} (REMISE)` }
    }

    return { scorer: defender, verdict: `POINT ${defender.toUpperCase()} (LATE RIPOSTE STILL LANDS)` }
  }

  if (answers.step3DefenderThenAttack === 'yes') {
    return { scorer: defender, verdict: `POINT ${defender.toUpperCase()} (ATTACK AFTER FAIL)` }
  }

  return { scorer: 'none', verdict: 'NO TOUCH' }
}
