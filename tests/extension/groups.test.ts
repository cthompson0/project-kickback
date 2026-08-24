import { beforeEach, describe, expect, it } from 'vitest'
import { createGroupsService } from '../../src/background/groups'
import type { GroupsBackend } from '../../src/background/groups'
import { createMemoryStorageArea } from '../../src/background/storage'
import type { BackendResult } from '../../src/background/auth'
import type {
  ChatMessage,
  GroupInvite,
  GroupMember,
  GroupSummary,
} from '../../src/client/types'

/**
 * The groups service: chat buffering, unread derivation, and mute.
 *
 * The property worth protecting is that unread is DERIVED from the message
 * buffer rather than incremented, which is what makes a reconnect that
 * replays messages harmless.
 */

const SELF = 'u-me'
const GROUP = 'g-boys'

function summary(overrides: Partial<GroupSummary> = {}): GroupSummary {
  return {
    groupId: GROUP,
    name: 'The Boys',
    icon: null,
    ownerId: SELF,
    isOwner: true,
    memberCount: 3,
    ...overrides,
  }
}

function member(id: string, name: string): GroupMember {
  return {
    user: { id, username: name.toLowerCase(), displayName: name, avatarUrl: null },
    role: 'member',
    presence: null,
  }
}

let clock = 0
function message(userId: string, body: string, id = `m${++clock}`): ChatMessage {
  return {
    id,
    groupId: GROUP,
    userId,
    displayName: userId === SELF ? 'Me' : userId,
    avatarUrl: null,
    body,
    // Ordered, monotonically increasing, and comparable as strings.
    createdAt: new Date(1_700_000_000_000 + clock * 1000).toISOString(),
  }
}

class FakeGroupsBackend implements GroupsBackend {
  groups: GroupSummary[] = []
  invites: GroupInvite[] = []
  members: GroupMember[] = []
  messages: ChatMessage[] = []
  calls: string[] = []
  failWith: string | null = null

  private ok<T>(value: T): BackendResult<T> {
    if (this.failWith) return { value: null, error: this.failWith }
    return { value }
  }

  async listGroups() {
    this.calls.push('listGroups')
    return this.ok([...this.groups])
  }
  async listInvites() {
    return this.ok([...this.invites])
  }
  async listMembers() {
    return this.ok([...this.members])
  }
  async listMessages() {
    return this.ok([...this.messages])
  }
  async createGroup(name: string, icon: string | null) {
    this.calls.push(`createGroup:${name}:${icon ?? '-'}`)
    return this.ok('g-new')
  }
  /** Owner-only on the server; the fake mirrors that with a plain list. */
  sentInvites: Record<string, string[]> = {}
  async cancelGroupInvite(groupId: string, userId: string) {
    this.calls.push(`cancelInvite:${groupId}:${userId}`)
    this.sentInvites[groupId] = (this.sentInvites[groupId] ?? []).filter((id) => id !== userId)
    return this.ok('cancelled')
  }
  async listSentInvites(groupId: string) {
    this.calls.push(`listSentInvites:${groupId}`)
    return this.ok(this.sentInvites[groupId] ?? [])
  }
  async setGroupIcon(groupId: string, icon: string | null) {
    this.calls.push(`setIcon:${groupId}:${icon ?? '-'}`)
    return this.ok(groupId)
  }
  async renameGroup(groupId: string, name: string) {
    this.calls.push(`rename:${groupId}:${name}`)
    return this.ok(name)
  }
  async deleteGroup(groupId: string) {
    this.calls.push(`delete:${groupId}`)
    return this.ok(true)
  }
  async inviteToGroup(groupId: string, userId: string) {
    this.calls.push(`invite:${groupId}:${userId}`)
    return this.ok('invited')
  }
  async respondToInvite(inviteId: string, accept: boolean) {
    this.calls.push(`respond:${inviteId}:${accept}`)
    return this.ok(accept ? 'accepted' : 'declined')
  }
  async leaveGroup(groupId: string) {
    this.calls.push(`leave:${groupId}`)
    return this.ok(true)
  }
  async removeMember(groupId: string, userId: string) {
    this.calls.push(`remove:${groupId}:${userId}`)
    return this.ok(true)
  }
  async sendMessage(groupId: string, body: string) {
    this.calls.push(`send:${groupId}:${body}`)
    return this.ok('m-new')
  }
}

let backend: FakeGroupsBackend

beforeEach(() => {
  clock = 0
  backend = new FakeGroupsBackend()
})

const service = (storage?: ReturnType<typeof createMemoryStorageArea>) =>
  createGroupsService({ backend, storage, selfId: () => SELF })

describe('loading groups', () => {
  it('starts empty', () => {
    expect(service().getState()).toMatchObject({ groups: [], invites: [] })
  })

  it('loads groups with their members and recent messages', async () => {
    backend.groups = [summary()]
    backend.members = [member('u-b', 'Bob')]
    backend.messages = [message('u-b', 'hello')]

    const groups = service()
    await groups.refresh()

    expect(groups.getState().groups).toHaveLength(1)
    expect(groups.getState().members[GROUP]).toHaveLength(1)
    expect(groups.getState().messages[GROUP]).toHaveLength(1)
  })

  it('forgets a conversation once we are no longer in the group', async () => {
    backend.groups = [summary()]
    backend.messages = [message('u-b', 'hello')]
    const groups = service()
    await groups.refresh()
    expect(groups.getState().messages[GROUP]).toBeDefined()

    backend.groups = []
    await groups.refresh()

    expect(groups.getState().messages[GROUP]).toBeUndefined()
  })

  it('surfaces a load failure without emptying what it had', async () => {
    backend.groups = [summary()]
    const groups = service()
    await groups.refresh()

    backend.failWith = 'network down'
    await groups.refresh()

    expect(groups.getState().groups).toHaveLength(1)
    expect(groups.getState().groupsError).toBeTruthy()
  })

  it('clears everything on sign-out', async () => {
    backend.groups = [summary()]
    const groups = service()
    await groups.refresh()

    groups.clear()
    expect(groups.getState().groups).toEqual([])
    expect(groups.getState().messages).toEqual({})
  })
})

describe('realtime messages', () => {
  it('appends a message without re-reading the conversation', async () => {
    backend.groups = [summary()]
    const groups = service()
    await groups.refresh()
    const before = backend.calls.filter((call) => call === 'listGroups').length

    groups.applyMessage(message('u-b', 'this guy is cooked'))

    expect(groups.getState().messages[GROUP]).toHaveLength(1)
    expect(backend.calls.filter((call) => call === 'listGroups')).toHaveLength(before)
  })

  it('ignores a message for a group we are not in', async () => {
    const groups = service()
    await groups.refresh()

    groups.applyMessage(message('u-b', 'not for us'))
    expect(groups.getState().messages[GROUP]).toBeUndefined()
  })

  it('ignores a duplicate delivered twice around a reconnect', async () => {
    backend.groups = [summary()]
    const groups = service()
    await groups.refresh()

    const duplicate = message('u-b', 'hello')
    groups.applyMessage(duplicate)
    groups.applyMessage(duplicate)

    expect(groups.getState().messages[GROUP]).toHaveLength(1)
  })

  it('keeps messages in order however they arrive', async () => {
    backend.groups = [summary()]
    const groups = service()
    await groups.refresh()

    const first = message('u-b', 'one')
    const second = message('u-c', 'two')
    // Out of order, as a racing socket might.
    groups.applyMessage(second)
    groups.applyMessage(first)

    expect(groups.getState().messages[GROUP].map((entry) => entry.body)).toEqual(['one', 'two'])
  })
})

describe('unread is derived, never counted', () => {
  it('counts messages from other people', async () => {
    backend.groups = [summary()]
    const groups = service()
    await groups.refresh()

    groups.applyMessage(message('u-b', 'one'))
    groups.applyMessage(message('u-c', 'two'))

    expect(groups.getState().groupUnread[GROUP]).toBe(2)
  })

  it('never counts our own messages', async () => {
    backend.groups = [summary()]
    const groups = service()
    await groups.refresh()

    groups.applyMessage(message(SELF, 'mine'))

    expect(groups.getState().groupUnread[GROUP]).toBe(0)
  })

  it('clears when the group is read', async () => {
    backend.groups = [summary()]
    const groups = service()
    await groups.refresh()
    groups.applyMessage(message('u-b', 'one'))

    groups.markGroupRead(GROUP)

    expect(groups.getState().groupUnread[GROUP]).toBe(0)
  })

  it('counts only what arrived after it was read', async () => {
    backend.groups = [summary()]
    const groups = service()
    await groups.refresh()
    groups.applyMessage(message('u-b', 'one'))
    groups.markGroupRead(GROUP)

    groups.applyMessage(message('u-c', 'two'))

    expect(groups.getState().groupUnread[GROUP]).toBe(1)
  })

  it('does not inflate when realtime replays the same messages', async () => {
    // The point of deriving rather than incrementing.
    backend.groups = [summary()]
    const groups = service()
    await groups.refresh()

    const one = message('u-b', 'one')
    const two = message('u-c', 'two')
    groups.applyMessage(one)
    groups.applyMessage(two)
    expect(groups.getState().groupUnread[GROUP]).toBe(2)

    // Reconnect: the same rows arrive again.
    groups.applyMessage(one)
    groups.applyMessage(two)

    expect(groups.getState().groupUnread[GROUP]).toBe(2)
  })

  it('does not inflate when a refresh reloads history', async () => {
    backend.groups = [summary()]
    backend.messages = [message('u-b', 'one'), message('u-c', 'two')]
    const groups = service()
    await groups.refresh()
    expect(groups.getState().groupUnread[GROUP]).toBe(2)

    await groups.refresh()
    await groups.refresh()

    expect(groups.getState().groupUnread[GROUP]).toBe(2)
  })

  it('remembers what was read across a worker restart', async () => {
    const storage = createMemoryStorageArea()
    backend.groups = [summary()]
    backend.messages = [message('u-b', 'one')]

    const first = service(storage)
    await first.refresh()
    first.markGroupRead(GROUP)
    expect(first.getState().groupUnread[GROUP]).toBe(0)

    const revived = service(storage)
    await revived.hydrate()
    await revived.refresh()

    expect(revived.getState().groupUnread[GROUP]).toBe(0)
  })
})

describe('mute', () => {
  it('remembers a muted group', async () => {
    const storage = createMemoryStorageArea()
    const groups = service(storage)
    await groups.setMuted(GROUP, true)
    expect(groups.getState().mutedGroupIds).toEqual([GROUP])

    const revived = service(storage)
    await revived.hydrate()
    expect(revived.getState().mutedGroupIds).toEqual([GROUP])
  })

  it('unmutes again', async () => {
    const groups = service(createMemoryStorageArea())
    await groups.setMuted(GROUP, true)
    await groups.setMuted(GROUP, false)
    expect(groups.getState().mutedGroupIds).toEqual([])
  })

  it('still counts unread for a muted group, for its own row', async () => {
    // Muting keeps it out of the launcher badge, not out of existence.
    backend.groups = [summary()]
    const groups = service()
    await groups.refresh()
    await groups.setMuted(GROUP, true)

    groups.applyMessage(message('u-b', 'one'))

    expect(groups.getState().groupUnread[GROUP]).toBe(1)
    expect(groups.getState().mutedGroupIds).toContain(GROUP)
  })
})

describe('group actions reach the backend', () => {
  it('creates, renames and deletes', async () => {
    const groups = service()
    await groups.createGroup('The Boys')
    await groups.renameGroup(GROUP, 'The Lads')
    await groups.deleteGroup(GROUP)

    expect(backend.calls).toContain('createGroup:The Boys:-')
    expect(backend.calls).toContain(`rename:${GROUP}:The Lads`)
    expect(backend.calls).toContain(`delete:${GROUP}`)
  })

  it('invites, responds, leaves and removes', async () => {
    const groups = service()
    await groups.invite(GROUP, 'u-b')
    await groups.respondToInvite('i-1', true)
    await groups.leaveGroup(GROUP)
    await groups.removeMember(GROUP, 'u-b')

    expect(backend.calls).toContain(`invite:${GROUP}:u-b`)
    expect(backend.calls).toContain('respond:i-1:true')
    expect(backend.calls).toContain(`leave:${GROUP}`)
    expect(backend.calls).toContain(`remove:${GROUP}:u-b`)
  })

  it('sends without re-reading the conversation', async () => {
    backend.groups = [summary()]
    const groups = service()
    await groups.refresh()
    const before = backend.calls.filter((call) => call === 'listGroups').length

    await groups.sendMessage(GROUP, 'hello')

    expect(backend.calls).toContain(`send:${GROUP}:hello`)
    // The realtime event brings the message back; no reload.
    expect(backend.calls.filter((call) => call === 'listGroups')).toHaveLength(before)
  })

  it('passes a database complaint through in words a person can read', async () => {
    backend.failWith = 'kickback: message is too long'
    const groups = service()

    await expect(groups.sendMessage(GROUP, 'x'.repeat(600))).rejects.toThrow('message is too long')
  })

  it('reports a generic failure without leaking internals', async () => {
    backend.failWith = 'TypeError: fetch failed at internal://line'
    const groups = service()

    await expect(groups.createGroup('x')).rejects.toThrow(/Could not create that group/i)
  })
})
