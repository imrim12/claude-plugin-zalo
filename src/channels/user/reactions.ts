// Zalo reactions are codes, not unicode emoji. Map the common emoji so the
// model can pass what it would pass Telegram; raw zca codes pass through.
import { Reactions } from 'zca-js'

const EMOJI_TO_REACTION: Record<string, Reactions> = {
  '👍': Reactions.LIKE,
  '👎': Reactions.DISLIKE,
  '❤️': Reactions.HEART,
  '❤': Reactions.HEART,
  '😂': Reactions.TEARS_OF_JOY,
  '😆': Reactions.HAHA,
  '😮': Reactions.WOW,
  '😢': Reactions.CRY,
  '😡': Reactions.ANGRY,
  '😘': Reactions.KISS,
  '🌹': Reactions.ROSE,
  '💔': Reactions.BROKEN_HEART,
  '🙏': Reactions.PRAY,
  '👌': Reactions.OK,
  '✅': Reactions.OK,
  '❌': Reactions.NO,
  '🎉': Reactions.HANDCLAP,
  '👏': Reactions.HANDCLAP,
}

const REACTION_CODES = new Set<string>(Object.values(Reactions))

export function reactionGet(emoji: string): Reactions {
  const mapped = EMOJI_TO_REACTION[emoji]
  if (mapped) return mapped
  if (REACTION_CODES.has(emoji)) return emoji as Reactions
  throw new Error(
    `unsupported reaction ${JSON.stringify(emoji)} — use one of ${Object.keys(EMOJI_TO_REACTION).join(' ')} or a zca reaction code`,
  )
}
