import { Injectable } from '@nestjs/common';

import { isNonEmptyString } from '@sniptt/guards';
import chunk from 'lodash.chunk';
import { isEmail } from 'class-validator';
import { QUERY_MAX_RECORDS } from 'twenty-shared/constants';
import { isDefined } from 'twenty-shared/utils';
import { In } from 'typeorm';

import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import {
  type MatchParticipantsArgs,
  MatchParticipantService,
} from 'src/modules/match-participant/match-participant.service';
import { type MessageParticipantWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-participant.workspace-entity';
import { type ParticipantWithMessageId } from 'src/modules/messaging/message-import-manager/drivers/gmail/types/gmail-message.type';

@Injectable()
export class MessagingMessageParticipantService {
  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    private readonly matchParticipantService: MatchParticipantService<MessageParticipantWorkspaceEntity>,
  ) {}

  public async saveMessageParticipants(
    participants: ParticipantWithMessageId[],
    workspaceId: string,
    transactionScope: WorkspaceTransactionScope,
  ): Promise<MessageParticipantWorkspaceEntity[]> {
    const authContext = buildSystemAuthContext(workspaceId);

    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const messageParticipantRepository =
          transactionScope.getRepository<MessageParticipantWorkspaceEntity>(
            'messageParticipant',
            { shouldBypassPermissionChecks: true },
          );

        const existingParticipantsBasedOnMessageIds =
          await messageParticipantRepository.find({
            where: {
              messageId: In(
                participants.map((participant) => participant.messageId),
              ),
            },
          });

        const normalizeHandle = (handle: string | null) =>
          isNonEmptyString(handle) && isEmail(handle.replace(/\s/g, ''))
            ? handle.replace(/\s/g, '').toLowerCase()
            : handle;

        const findExisting = (participant: ParticipantWithMessageId) =>
          existingParticipantsBasedOnMessageIds.find(
            (existingParticipant) =>
              existingParticipant.messageId === participant.messageId &&
              normalizeHandle(existingParticipant.handle) ===
                normalizeHandle(participant.handle) &&
              existingParticipant.role === participant.role,
          );

        const participantsWithExisting = participants.map((participant) => ({
          participant,
          existingParticipant: findExisting(participant),
        }));

        const participantsToCreate: Pick<
          MessageParticipantWorkspaceEntity,
          | 'messageId'
          | 'handle'
          | 'displayName'
          | 'role'
          | 'personId'
          | 'workspaceMemberId'
        >[] = participantsWithExisting
          .filter(({ existingParticipant }) => !isDefined(existingParticipant))
          .map(({ participant }) => {
            return {
              messageId: participant.messageId,
              handle: participant.handle,
              displayName: participant.displayName,
              role: participant.role,
              personId: participant.personId ?? null,
              workspaceMemberId: participant.workspaceMemberId ?? null,
            };
          });

        const identityUpdates = participantsWithExisting.flatMap(
          ({ participant, existingParticipant }) => {
            if (!isDefined(existingParticipant)) {
              return [];
            }

            const personId =
              participant.personId ?? existingParticipant.personId;
            const workspaceMemberId =
              participant.workspaceMemberId ??
              existingParticipant.workspaceMemberId;
            const displayName =
              isNonEmptyString(participant.displayName) &&
              (participant.displayName !== participant.handle ||
                !isNonEmptyString(existingParticipant.displayName))
                ? participant.displayName
                : existingParticipant.displayName;

            if (
              personId === existingParticipant.personId &&
              workspaceMemberId === existingParticipant.workspaceMemberId &&
              displayName === existingParticipant.displayName
            ) {
              return [];
            }

            return [
              {
                criteria: existingParticipant.id,
                partialEntity: { personId, workspaceMemberId, displayName },
              },
            ];
          },
        );

        // Batches are bounded by messages, not participants, so they can exceed what updateMany accepts
        for (const identityUpdatesChunk of chunk(
          identityUpdates,
          QUERY_MAX_RECORDS,
        )) {
          await messageParticipantRepository.updateMany(identityUpdatesChunk);
        }

        const { identifiers } =
          await messageParticipantRepository.insert(participantsToCreate);

        const touchedIds = [
          ...identifiers.map(({ id }) => id),
          ...participantsWithExisting
            .map(({ existingParticipant }) => existingParticipant?.id)
            .filter(isDefined),
        ];

        return messageParticipantRepository.find({
          where: { id: In(touchedIds) },
        });
      },
      authContext,
      { lite: true },
    );
  }

  public async matchMessageParticipants({
    participants,
    messageIds,
    workspaceId,
    matchWith = 'workspaceMemberAndPerson',
  }: {
    participants: MessageParticipantWorkspaceEntity[];
    messageIds: string[];
    workspaceId: string;
    matchWith?: MatchParticipantsArgs<MessageParticipantWorkspaceEntity>['matchWith'];
  }): Promise<void> {
    const authContext = buildSystemAuthContext(workspaceId);

    await this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        await this.matchParticipantService.matchParticipants({
          participants,
          sourceRecordIds: messageIds,
          objectMetadataName: 'messageParticipant',
          matchWith,
        });
      },
      authContext,
      { lite: true },
    );
  }
}
