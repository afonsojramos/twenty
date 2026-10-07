import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { isDefined } from 'twenty-shared/utils';
import { Repository } from 'typeorm';
import { ConnectedAccountProvider } from 'twenty-shared/types';

import { InjectCacheStorage } from 'src/engine/core-modules/cache-storage/decorators/cache-storage.decorator';
import { CacheStorageService } from 'src/engine/core-modules/cache-storage/services/cache-storage.service';
import { CacheStorageNamespace } from 'src/engine/core-modules/cache-storage/types/cache-storage-namespace.enum';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { MessagingSaveMessagesAndEnqueueContactCreationService } from 'src/modules/messaging/message-import-manager/services/messaging-save-messages-and-enqueue-contact-creation.service';
import { type PersistSentMessageInput } from 'src/modules/messaging/message-outbound-manager/types/persist-sent-message-input.type';
import { type PersistedSentMessage } from 'src/modules/messaging/message-outbound-manager/types/persisted-sent-message.type';
import { formatSentMessage } from 'src/modules/messaging/message-outbound-manager/utils/format-sent-message.util';

@Injectable()
export class SentMessagePersistenceService {
  constructor(
    @InjectCacheStorage(CacheStorageNamespace.ModuleMessaging)
    private readonly cacheStorage: CacheStorageService,
    @InjectRepository(MessageChannelEntity)
    private readonly messageChannelRepository: Repository<MessageChannelEntity>,
    private readonly saveMessagesAndEnqueueContactCreationService: MessagingSaveMessagesAndEnqueueContactCreationService,
  ) {}

  async persistSentMessage(
    input: PersistSentMessageInput,
  ): Promise<PersistedSentMessage | undefined> {
    const messageChannel = await this.messageChannelRepository.findOneOrFail({
      where: {
        id: input.messageChannelId,
        workspaceId: input.workspaceId,
      },
      relations: { connectedAccount: true },
    });

    if (
      messageChannel.connectedAccount.provider ===
        ConnectedAccountProvider.GOOGLE &&
      isDefined(input.sendResult.messageExternalId)
    ) {
      await this.cacheStorage.setAdd(
        `messages-to-reconcile:${input.workspaceId}:${messageChannel.id}`,
        [input.sendResult.messageExternalId],
        7 * 24 * 60 * 60 * 1000,
      );
    }

    const messageToSave = formatSentMessage(input);

    const savedMessagesResult =
      await this.saveMessagesAndEnqueueContactCreationService.saveMessagesAndEnqueueContactCreation(
        [messageToSave],
        messageChannel,
        messageChannel.connectedAccount,
        input.workspaceId,
      );

    const messageId = savedMessagesResult?.messageExternalIdsAndIdsMap.get(
      messageToSave.externalId,
    );
    const messageThreadId =
      savedMessagesResult?.messageExternalIdToMessageThreadIdMap.get(
        messageToSave.externalId,
      );

    if (!isDefined(messageId) || !isDefined(messageThreadId)) {
      return undefined;
    }

    return { messageId, messageThreadId };
  }
}
