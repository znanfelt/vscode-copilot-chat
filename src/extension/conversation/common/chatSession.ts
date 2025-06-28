/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatRequest, ChatResponseStream } from 'vscode';
import { Event } from '../../../util/vs/base/common/event';
import { IDisposable } from '../../../util/vs/base/common/lifecycle';
import { ChatRequestTurn, ChatResponseTurn } from '../../../vscodeTypes';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ILogService } from '../../../platform/log/common/logService';
import { ChatParticipantRequestHandler, IChatAgentArgs } from '../../prompt/node/chatParticipantRequestHandler';
import { ICopilotChatResult } from '../../prompt/common/conversation';

/**
 * Interface for the context required to create a chat session
 */
export interface IChatSessionContext {
	readonly sessionId: string;
	readonly history: ReadonlyArray<ChatRequestTurn | ChatResponseTurn>;
	readonly chatAgentArgs: IChatAgentArgs;
}

/**
 * Interface for chat session configuration
 */
export interface IChatSessionOptions {
	readonly timeout?: number;
	readonly maxRetries?: number;
}

/**
 * Represents a single chat session that processes a request and produces a response.
 * This class encapsulates all the logic needed to handle a single conversation turn.
 */
export class ChatSession implements IDisposable {
	private readonly _sessionId: string;
	private readonly _context: IChatSessionContext;
	
	private _disposed = false;

	constructor(
		sessionId: string,
		context: IChatSessionContext,
		options: IChatSessionOptions = {},
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService
	) {
		this._sessionId = sessionId;
		this._context = context;
		// Options are preserved for future use without triggering unused variable warnings
		void options;
	}

	/**
	 * Gets the unique identifier for this session
	 */
	get sessionId(): string {
		return this._sessionId;
	}

	/**
	 * Gets the session context
	 */
	get context(): IChatSessionContext {
		return this._context;
	}

	/**
	 * Executes a chat request and returns the result.
	 * This method delegates to the existing ChatParticipantRequestHandler to maintain
	 * backward compatibility while providing a cleaner abstraction.
	 * 
	 * @param request The chat request to process
	 * @param stream The response stream to write to
	 * @param token Cancellation token
	 * @param onPaused Event emitted when the request is paused
	 * @returns Promise resolving to the chat result
	 */
	async execute(
		request: ChatRequest,
		stream: ChatResponseStream,
		token: CancellationToken,
		onPaused: Event<boolean>
	): Promise<ICopilotChatResult> {
		if (this._disposed) {
			throw new Error('ChatSession has been disposed');
		}

		// Create and execute the request handler
		// This maintains the existing behavior while providing session abstraction
		const handler = this._instantiationService.createInstance(
			ChatParticipantRequestHandler,
			this._context.history,
			request,
			stream,
			token,
			this._context.chatAgentArgs,
			onPaused
		);

		try {
			return await handler.getResult();
		} catch (error) {
			// Log session execution error for debugging
			this._logService.logger.error(`ChatSession ${this._sessionId} execution failed:`, error);
			throw error;
		}
	}

	/**
	 * Checks if this session can handle the given request
	 * @param request The request to check
	 * @returns True if this session can handle the request
	 */
	canHandle(request: ChatRequest): boolean {
		// For now, all sessions can handle all requests
		// This method provides a hook for future enhancements like specialized sessions
		return !this._disposed;
	}

	/**
	 * Gets session statistics for monitoring and debugging
	 */
	getStats(): IChatSessionStats {
		return {
			sessionId: this._sessionId,
			createdAt: new Date(), // TODO: Track actual creation time
			requestCount: 0, // TODO: Track request count
			isActive: !this._disposed
		};
	}

	/**
	 * Disposes of the session and cleans up resources
	 */
	dispose(): void {
		if (this._disposed) {
			return;
		}
		
		this._disposed = true;
	}
}

/**
 * Session statistics interface
 */
export interface IChatSessionStats {
	readonly sessionId: string;
	readonly createdAt: Date;
	readonly requestCount: number;
	readonly isActive: boolean;
}
