import { randomUUID } from 'node:crypto';

import {
  ConnectedAccountProvider,
  MessageFolderImportPolicy,
  MessageParticipantRole,
} from 'twenty-shared/types';

import { type CacheStorageService } from 'src/engine/core-modules/cache-storage/services/cache-storage.service';
import { CacheStorageNamespace } from 'src/engine/core-modules/cache-storage/types/cache-storage-namespace.enum';
import { MessageFolderEntity } from 'src/engine/metadata-modules/message-folder/entities/message-folder.entity';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { SEED_APPLE_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';
import { MessagingMessageParticipantService } from 'src/modules/messaging/message-participant-manager/services/messaging-message-participant.service';
import { SentMessagePersistenceService } from 'src/modules/messaging/message-outbound-manager/services/sent-message-persistence.service';
import { type PersistSentMessageInput } from 'src/modules/messaging/message-outbound-manager/types/persist-sent-message-input.type';

import { gmailMessage } from 'test/integration/google/mocks/gmail-message.util';
import { setupGoogleMock } from 'test/integration/google/mocks/setup-google-mock.util';
import { runWorkflowActionStep } from 'test/integration/graphql/suites/workflow/utils/run-workflow-action-step.util';
import { connectMessagingAccount } from 'test/integration/utils/connect-messaging-account.util';
import { findRecordNodesByFilter } from 'test/integration/utils/find-records-by-filter.util';
import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';
import { getCoreRepository } from 'test/integration/utils/get-core-repository.util';
import {
  queryMessageFolders,
  updateMessageChannel,
} from 'test/integration/utils/query-messaging.util';
import { resetMessageChannelSyncState } from 'test/integration/utils/reset-channel-sync-state.util';
import { runMessageChannelSync } from 'test/integration/utils/run-message-channel-sync.util';
import { sendEmail } from 'test/integration/utils/send-email.util';
import { setTestConnectedAccountHandleAliases } from 'test/integration/utils/set-test-connected-account-handle-aliases.util';

const HANDLE = 'gmail-send-reconciliation@apple.dev';
const ALIAS = 'gmail-send-reconciliation-alias@apple.dev';
const RECIPIENT = 'gmail-send-reconciliation-recipient@example.com';

describe('Gmail sent-message reconciliation (integration)', () => {
  const google = setupGoogleMock({ handle: HANDLE });
  let channel: Awaited<ReturnType<typeof connectMessagingAccount>>;

  beforeAll(async () => {
    channel = await connectMessagingAccount({
      provider: ConnectedAccountProvider.GOOGLE,
      handle: HANDLE,
    });
    await setTestConnectedAccountHandleAliases({
      connectedAccountId: channel.connectedAccountId,
      handleAliases: [ALIAS],
    });
  }, 60000);

  afterAll(async () => {
    if (channel) {
      await channel.cleanup();
    }
  });

  const findMessages = (subject: string) =>
    findRecordNodesByFilter<{
      id: string;
      headerMessageId: string;
      messageThreadId: string;
    }>('message', 'messages', 'id headerMessageId messageThreadId', {
      subject: { eq: subject },
    });

  const send = (subject: string) =>
    runWorkflowActionStep({
      name: 'Gmail reconciliation send',
      stepType: 'SEND_EMAIL',
      input: {
        connectedAccountId: channel.connectedAccountId,
        fromHandle: ` ${ALIAS.toUpperCase()} `,
        recipients: { to: RECIPIENT, cc: '', bcc: '' },
        subject,
        body: '<p>Reconciliation body</p>',
      },
    });

  it.each([true, false])(
    'keeps one row after send, import and repeated import (metadata available: %s)',
    async (metadataAvailable) => {
      const subject = `Gmail reconciliation ${randomUUID()}`;
      const providerId = `gmail-sent-${google.sentMessages.length + 1}`;
      const sent = gmailMessage({
        id: providerId,
        from: `Sender Name <${ALIAS}>`,
        to: `Recipient Name <${RECIPIENT}>`,
        labelIds: ['INBOX', 'SENT'],
      });

      sent.payload = {
        ...sent.payload,
        headers: [
          ...(sent.payload?.headers ?? []).filter(
            (header) => header.name !== 'Subject',
          ),
          { name: 'Subject', value: subject },
        ],
      };

      if (metadataAvailable) {
        google.serveMailbox([sent]);
      }

      const result = await send(subject);

      expect(result).toMatchObject({
        status: 'COMPLETED',
        stepStatus: 'SUCCESS',
      });
      const [initial] = await findMessages(subject);

      if (metadataAvailable) {
        expect(initial.headerMessageId).toBe(`<${providerId}@example.com>`);
      }

      expect(
        await findRecordNodesByFilter<{ handle: string }>(
          'messageParticipant',
          'messageParticipants',
          'handle',
          {
            messageId: { eq: initial.id },
            role: { eq: 'FROM' },
          },
        ),
      ).toEqual([expect.objectContaining({ handle: ALIAS })]);

      google.serveMailbox([sent]);
      for (let iteration = 0; iteration < 2; iteration++) {
        await resetMessageChannelSyncState(channel.channelId, '');
        await runMessageChannelSync(channel.channelId);
        expect(await findMessages(subject)).toEqual([
          { ...initial, headerMessageId: `<${providerId}@example.com>` },
        ]);
        const participants = await findRecordNodesByFilter<{
          handle: string;
          displayName: string;
          role: string;
        }>(
          'messageParticipant',
          'messageParticipants',
          'handle displayName role',
          {
            messageId: { eq: initial.id },
          },
        );

        expect(participants).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              handle: ALIAS,
              displayName: 'Sender Name',
              role: 'FROM',
            }),
            expect.objectContaining({
              handle: RECIPIENT,
              displayName: 'Recipient Name',
              role: 'TO',
            }),
          ]),
        );
        expect(participants).toHaveLength(2);
      }

      const persistence =
        getAppProviderByClassName<SentMessagePersistenceService>(
          'SentMessagePersistenceService',
        );

      await persistence.persistSentMessage({
        sendResult: {
          headerMessageId: initial.headerMessageId,
          messageExternalId: providerId,
          threadExternalId: providerId,
        },
        subject,
        body: '',
        recipients: { to: [RECIPIENT], cc: [], bcc: [] },
        connectedAccount: { id: channel.connectedAccountId, handle: HANDLE },
        fromHandle: ALIAS,
        messageChannelId: channel.channelId,
        workspaceId: SEED_APPLE_WORKSPACE_ID,
      });
      expect(await findMessages(subject)).toEqual([
        { ...initial, headerMessageId: `<${providerId}@example.com>` },
      ]);

      const reply = gmailMessage({
        id: `reply-${randomUUID()}`,
        threadId: providerId,
        from: RECIPIENT,
        to: ALIAS,
      });

      google.serveMailbox([sent, reply]);
      await resetMessageChannelSyncState(channel.channelId, '');
      await runMessageChannelSync(channel.channelId);
      const replies = await findRecordNodesByFilter<{
        messageThreadId: string;
      }>('message', 'messages', 'messageThreadId', {
        headerMessageId: { eq: `<${reply.id}@example.com>` },
      });

      expect(replies).toEqual([
        expect.objectContaining({ messageThreadId: initial.messageThreadId }),
      ]);
      expect(
        google.sentMessages.filter(({ raw }) => raw.includes(subject)),
      ).toHaveLength(1);

      const outboundReply = await sendEmail({
        connectedAccountId: channel.connectedAccountId,
        fromHandle: ALIAS,
        to: RECIPIENT,
        subject: `Re: ${subject}`,
        body: 'Follow-up reply',
        inReplyTo: `<${providerId}@example.com>`,
      });

      expect(outboundReply).toMatchObject({ success: true });
      const [lastSent] = google.sentMessages.slice(-1);

      expect(lastSent.raw).toContain(
        `In-Reply-To: <${providerId}@example.com>`,
      );
      expect(
        lastSent.raw
          .replace(/\r?\n[ \t]+/g, ' ')
          .match(/^References:.*$/m)?.[0],
      ).toContain(`<${providerId}@example.com>`);
      expect(lastSent.threadId).toBe(providerId);
    },
    120000,
  );

  it('returns one successful send when the metadata read stalls', async () => {
    const subject = `Gmail stalled metadata ${randomUUID()}`;
    const sendCount = google.sentMessages.length;

    google.stallMessageMetadata();
    const startedAt = Date.now();

    expect(await send(subject)).toMatchObject({
      status: 'COMPLETED',
      stepStatus: 'SUCCESS',
    });
    expect(Date.now() - startedAt).toBeLessThan(9000);
    expect(google.sentMessages).toHaveLength(sendCount + 1);
    expect(await findMessages(subject)).toHaveLength(1);
  }, 120000);

  it.each([true, false])(
    'recovers only messages in the selected Sent folder (Sent message: %s)',
    async (inSelectedFolder) => {
      google.serveMailbox([]);
      await resetMessageChannelSyncState(channel.channelId, '');
      await runMessageChannelSync(channel.channelId);
      const folders = await queryMessageFolders(channel.channelId);
      const folderRepository =
        getCoreRepository<MessageFolderEntity>(MessageFolderEntity);

      for (const folder of folders) {
        await folderRepository.update(folder.id, {
          isSynced: folder.name === 'SENT',
        });
      }
      await updateMessageChannel(channel.channelId, {
        messageFolderImportPolicy: MessageFolderImportPolicy.SELECTED_FOLDERS,
      });

      try {
        const subject = `Gmail selected Sent recovery ${randomUUID()}`;
        const providerId = `gmail-sent-${google.sentMessages.length + 1}`;

        expect(await send(subject)).toMatchObject({ status: 'COMPLETED' });
        const [initial] = await findMessages(subject);
        const sent = gmailMessage({
          id: providerId,
          from: ALIAS,
          to: RECIPIENT,
          labelIds: [inSelectedFolder ? 'SENT' : 'INBOX'],
        });

        sent.payload = {
          ...sent.payload,
          headers: [
            ...(sent.payload?.headers ?? []).filter(
              (header) => header.name !== 'Subject',
            ),
            { name: 'Subject', value: subject },
          ],
        };
        google.serveMailbox([sent]);
        google.serveHistory([]);
        await resetMessageChannelSyncState(channel.channelId, '987654321');
        await runMessageChannelSync(channel.channelId);
        expect(await findMessages(subject)).toEqual([
          {
            ...initial,
            headerMessageId: inSelectedFolder
              ? `<${providerId}@example.com>`
              : initial.headerMessageId,
          },
        ]);
      } finally {
        await updateMessageChannel(channel.channelId, {
          messageFolderImportPolicy: MessageFolderImportPolicy.ALL_FOLDERS,
        });
        for (const folder of folders) {
          await folderRepository.update(folder.id, {
            isSynced: folder.isSynced,
          });
        }
      }
    },
    120000,
  );

  it('enriches an existing email participant and preserves case-sensitive nonemail handles', async () => {
    const subject = `Gmail participant reconciliation ${randomUUID()}`;

    expect(await send(subject)).toMatchObject({ status: 'COMPLETED' });
    const [message] = await findMessages(subject);
    const manager = getAppProviderByClassName<WorkspaceOrmManager>(
      'WorkspaceOrmManager',
    );
    const service =
      getAppProviderByClassName<MessagingMessageParticipantService>(
        'MessagingMessageParticipantService',
      );
    const save = (handle: string, displayName: string) =>
      manager.executeInWorkspaceContext(
        () =>
          manager.runInWorkspaceTransaction((transactionScope) =>
            service.saveMessageParticipants(
              [
                {
                  messageId: message.id,
                  handle,
                  displayName,
                  role: MessageParticipantRole.TO,
                },
              ],
              SEED_APPLE_WORKSPACE_ID,
              transactionScope,
            ),
          ),
        buildSystemAuthContext(SEED_APPLE_WORKSPACE_ID),
      );

    const [original] = await save('ada@example.com', 'Ada');

    expect(await save(' ADA@Example.com ', 'Ada L.')).toEqual([
      expect.objectContaining({ id: original.id, displayName: 'Ada L.' }),
    ]);
    expect(await save('ada@example.com', 'ada@example.com')).toEqual([
      expect.objectContaining({ id: original.id, displayName: 'Ada L.' }),
    ]);
    const [uppercaseHandle] = await save('@CaseSensitiveUser', 'Uppercase');
    const [lowercaseHandle] = await save('@casesensitiveuser', 'Lowercase');

    expect(uppercaseHandle.id).not.toBe(lowercaseHandle.id);
    const participants = await findRecordNodesByFilter<{ id: string }>(
      'messageParticipant',
      'messageParticipants',
      'id',
      { messageId: { eq: message.id } },
    );

    expect(participants).toHaveLength(5);
  }, 120000);

  it('recovers when a post-commit persistence effect fails', async () => {
    const subject = `Gmail post-commit reconciliation ${randomUUID()}`;
    const providerId = randomUUID();
    const sent = gmailMessage({
      id: providerId,
      from: ALIAS,
      to: RECIPIENT,
      labelIds: ['INBOX', 'SENT'],
    });

    sent.payload = {
      ...sent.payload,
      headers: [
        ...(sent.payload?.headers ?? []).filter(
          (header) => header.name !== 'Subject',
        ),
        { name: 'Subject', value: subject },
      ],
    };
    const participantService =
      getAppProviderByClassName<MessagingMessageParticipantService>(
        'MessagingMessageParticipantService',
      );
    const failedEffect = jest
      .spyOn(participantService, 'matchMessageParticipants')
      .mockRejectedValueOnce(new Error('Injected post-commit effect failure'));
    const persistence =
      getAppProviderByClassName<SentMessagePersistenceService>(
        'SentMessagePersistenceService',
      );

    try {
      await expect(
        persistence.persistSentMessage({
          sendResult: {
            headerMessageId: `<native-${providerId}@example.com>`,
            messageExternalId: providerId,
            threadExternalId: providerId,
          },
          subject,
          body: '',
          recipients: { to: [RECIPIENT], cc: [], bcc: [] },
          connectedAccount: { id: channel.connectedAccountId, handle: HANDLE },
          fromHandle: ALIAS,
          messageChannelId: channel.channelId,
          workspaceId: SEED_APPLE_WORKSPACE_ID,
        }),
      ).rejects.toThrow('Injected post-commit effect failure');
      const [initial] = await findMessages(subject);

      expect(initial).toEqual(
        expect.objectContaining({
          headerMessageId: `<native-${providerId}@example.com>`,
        }),
      );
      google.serveMailbox([sent]);
      await resetMessageChannelSyncState(channel.channelId, '');
      await runMessageChannelSync(channel.channelId);
      expect(await findMessages(subject)).toEqual([
        { ...initial, headerMessageId: `<${providerId}@example.com>` },
      ]);
      expect(failedEffect).toHaveBeenCalledTimes(2);
      expect(failedEffect.mock.calls[1][0].participants).toHaveLength(2);
    } finally {
      failedEffect.mockRestore();
    }
  }, 120000);

  it('reconciles concurrent saves with different headers and scopes provider IDs to the channel', async () => {
    const service = getAppProviderByClassName<SentMessagePersistenceService>(
      'SentMessagePersistenceService',
    );
    const subject = `Gmail concurrent reconciliation ${randomUUID()}`;
    const providerId = randomUUID();
    const input: PersistSentMessageInput = {
      sendResult: {
        headerMessageId: `<native-${providerId}@example.com>`,
        messageExternalId: providerId,
        threadExternalId: providerId,
      },
      subject,
      body: '',
      recipients: { to: [RECIPIENT], cc: [], bcc: [] },
      connectedAccount: { id: channel.connectedAccountId, handle: HANDLE },
      fromHandle: ALIAS,
      messageChannelId: channel.channelId,
      workspaceId: SEED_APPLE_WORKSPACE_ID,
    };
    const save = (headerMessageId: string, messageChannelId: string) =>
      service.persistSentMessage({
        ...input,
        messageChannelId,
        sendResult: { ...input.sendResult, headerMessageId },
      });
    const results = await Promise.all([
      save(`<native-${providerId}@example.com>`, channel.channelId),
      save(`<gmail-${providerId}@example.com>`, channel.channelId),
    ]);

    expect(results[0]).toEqual(
      expect.objectContaining({ messageId: expect.any(String) }),
    );
    expect(results[0]).toEqual(results[1]);
    expect(await findMessages(subject)).toHaveLength(1);

    const otherHandle = 'other-gmail-send-reconciliation@apple.dev';

    google.actAsAccount(otherHandle);
    const otherChannel = await connectMessagingAccount({
      provider: ConnectedAccountProvider.GOOGLE,
      handle: otherHandle,
    });

    try {
      await save(`<other-${providerId}@example.com>`, otherChannel.channelId);
      expect(await findMessages(subject)).toHaveLength(2);
    } finally {
      await otherChannel.cleanup();
    }
  }, 120000);

  it('deletes a native sent row removed from Gmail before reconciliation', async () => {
    const subject = `Gmail deleted native send ${randomUUID()}`;

    google.actAsAccount(HANDLE);
    google.serveMailbox([]);
    expect(await send(subject)).toMatchObject({ status: 'COMPLETED' });
    expect(await findMessages(subject)).toHaveLength(1);

    await resetMessageChannelSyncState(channel.channelId, '');
    await runMessageChannelSync(channel.channelId);
    expect(await findMessages(subject)).toHaveLength(0);
  }, 120000);

  it('honors an incremental Gmail deletion while native reconciliation is pending', async () => {
    const subject = `Gmail incremental deletion ${randomUUID()}`;

    google.actAsAccount(HANDLE);
    expect(await send(subject)).toMatchObject({ status: 'COMPLETED' });
    expect(await findMessages(subject)).toHaveLength(1);
    const providerId = `gmail-sent-${google.sentMessages.length}`;
    const cache = global.app.get<CacheStorageService>(
      CacheStorageNamespace.ModuleMessaging,
    );
    const pendingKey = `messages-to-reconcile:${SEED_APPLE_WORKSPACE_ID}:${channel.channelId}`;
    const importKey = `messages-to-import:${SEED_APPLE_WORKSPACE_ID}:${channel.channelId}`;

    expect(await cache.setMembers(pendingKey)).toContain(providerId);
    google.serveHistory([], [{ id: providerId, threadId: providerId }]);
    await resetMessageChannelSyncState(channel.channelId, '987654321');
    await runMessageChannelSync(channel.channelId);
    expect(await findMessages(subject)).toHaveLength(0);
    expect(await cache.setMembers(pendingKey)).not.toContain(providerId);
    expect(await cache.setMembers(importKey)).not.toContain(providerId);
  }, 120000);
});
