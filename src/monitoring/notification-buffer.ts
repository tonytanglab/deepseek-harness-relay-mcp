import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import {
  MonitoringError,
  type NotificationPage,
  type PublishNotificationInput,
  type PublishNotificationResult,
  type ResyncRequired,
  type RunNotification,
} from './types.js'

interface BufferedNotification {
  notification: RunNotification
  cursorNumber: number
  bytes: number
}

export class NotificationBuffer {
  readonly #maxItems: number
  readonly #maxBytes: number
  readonly #now: () => Date
  readonly #items: BufferedNotification[] = []
  #nextCursor = 1
  #totalBytes = 0
  #discardedThroughCursor = 0

  constructor(maxItems: number, maxBytes: number, now: () => Date) {
    if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
      throw new RangeError('maxQueueItems must be a positive safe integer')
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError('maxQueueBytes must be a positive safe integer')
    }
    this.#maxItems = maxItems
    this.#maxBytes = maxBytes
    this.#now = now
  }

  publish(input: PublishNotificationInput): PublishNotificationResult {
    const cursorNumber = this.#nextCursor
    const notification: RunNotification = {
      runId: input.runId,
      kind: input.kind,
      payload: structuredClone(input.payload),
      eventId: randomUUID(),
      cursor: String(cursorNumber),
      occurredAt: input.occurredAt ?? this.#now().toISOString(),
    }
    const bytes = Buffer.byteLength(JSON.stringify(notification), 'utf8')
    if (bytes > this.#maxBytes) {
      throw new MonitoringError(
        'NOTIFICATION_TOO_LARGE',
        `notification requires ${bytes} bytes, exceeding the ${this.#maxBytes} byte queue limit`,
        { latestCursor: this.latestCursor },
      )
    }

    this.#nextCursor += 1
    this.#items.push({ notification, cursorNumber, bytes })
    this.#totalBytes += bytes

    let overflowed = false
    while (this.#items.length > this.#maxItems || this.#totalBytes > this.#maxBytes) {
      const discarded = this.#items.shift()
      if (!discarded) break
      overflowed = true
      this.#totalBytes -= discarded.bytes
      this.#discardedThroughCursor = discarded.cursorNumber
    }

    const result: PublishNotificationResult = { notification: structuredClone(notification), overflowed }
    if (overflowed) result.resync = this.#resync('queue-overflow')
    return result
  }

  read(cursor?: string): NotificationPage {
    const cursorNumber = cursor === undefined ? this.#discardedThroughCursor : this.#parseCursor(cursor)
    if (cursorNumber < this.#discardedThroughCursor) {
      const resync = this.#resync('cursor-expired')
      throw new MonitoringError(
        'CURSOR_EXPIRED',
        `cursor ${cursorNumber} predates retained notifications`,
        { latestCursor: this.latestCursor, resync },
      )
    }
    if (cursorNumber > this.#nextCursor - 1) {
      throw new MonitoringError(
        'INVALID_CURSOR',
        `cursor ${cursorNumber} is ahead of the latest notification`,
        { latestCursor: this.latestCursor },
      )
    }

    const startIndex = this.#firstAfter(cursorNumber)
    return {
      notifications: this.#items.slice(startIndex).map(item => structuredClone(item.notification)),
      nextCursor: this.latestCursor,
    }
  }

  get latestCursor(): string {
    return String(this.#nextCursor - 1)
  }

  #parseCursor(cursor: string): number {
    if (!/^(0|[1-9]\d*)$/.test(cursor)) {
      throw new MonitoringError('INVALID_CURSOR', `cursor must be a non-negative integer: ${cursor}`, {
        latestCursor: this.latestCursor,
      })
    }
    const parsed = Number(cursor)
    if (!Number.isSafeInteger(parsed)) {
      throw new MonitoringError('INVALID_CURSOR', `cursor exceeds the safe integer range: ${cursor}`, {
        latestCursor: this.latestCursor,
      })
    }
    return parsed
  }

  #firstAfter(cursor: number): number {
    let low = 0
    let high = this.#items.length
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2)
      const item = this.#items[middle]
      if (item && item.cursorNumber <= cursor) low = middle + 1
      else high = middle
    }
    return low
  }

  #resync(reason: ResyncRequired['reason']): ResyncRequired {
    return {
      kind: 'resync-required',
      reason,
      discardedThroughCursor: String(this.#discardedThroughCursor),
      latestCursor: this.latestCursor,
    }
  }
}
