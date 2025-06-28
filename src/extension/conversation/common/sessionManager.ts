/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatRequest, ChatResponseStream } from 'vscode';
import { Event } from '../../../util/vs/base/common/event';
import { IDisposable, DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { ChatRequestTurn, ChatResponseTurn } from '../../../vscodeTypes';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ILogService } from '../../../platform/log/common/logService';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { ChatSession, IChatSessionContext, IChatSessionOptions, IChatSessionStats } from './chatSession';
import { IChatAgentArgs } from '../../prompt/node/chatParticipantRequestHandler';
import { ICopilotChatResult } from '../../prompt/common/conversation';

/**
 * Configuration options for the session manager
 */
export interface ISessionManagerOptions {
	readonly maxConcurrentSessions?: number;
	readonly sessionTimeout?: number;
	readonly enableSessionReuse?: boolean;
}

/**
 * Statistics for the session manager
 */
export interface ISessionManagerStats {
	readonly totalSessions: number;
	readonly activeSessions: number;
	readonly completedSessions: number;
	readonly failedSessions: number;
}

/**
 * Manages the lifecycle of chat sessions, providing session creation, tracking, and cleanup.
 * This class serves as the central coordinator for all chat session operations.
 */
export class SessionManager implements IDisposable {
	private readonly _disposables = new DisposableStore();
	private readonly _sessions = new Map<string, ChatSession>();
	private readonly _options: ISessionManagerOptions;
	
	private _totalSessions = 0;
	private _completedSessions = 0;
	private _failedSessions = 0;

	constructor(
		options: ISessionManagerOptions = {},
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService
	) {
		this._options = {
			maxConcurrentSessions: 10,
			sessionTimeout: 300000, // 5 minutes
			enableSessionReuse: false,
			...options
		};

		this._logService.logger.debug(`SessionManager initialized with maxConcurrentSessions: ${this._options.maxConcurrentSessions}, sessionTimeout: ${this._options.sessionTimeout}, enableSessionReuse: ${this._options.enableSessionReuse}`);
	}

	/**
	 * Handles a chat request by creating or reusing a session
	 * @param request The chat request to handle
	 * @param history The conversation history
	 * @param stream The response stream
	 * @param token Cancellation token
	 * @param chatAgentArgs Chat agent arguments
	 * @param onPaused Event emitted when request is paused
	 * @returns Promise resolving to the chat result
	 */
	async handleRequest(
		request: ChatRequest,
		history: ReadonlyArray<ChatRequestTurn | ChatResponseTurn>,
		stream: ChatResponseStream,
		token: CancellationToken,
		chatAgentArgs: IChatAgentArgs,
		onPaused: Event<boolean>
	): Promise<ICopilotChatResult> {
		// For now, create a new session for each request to maintain existing behavior
		// Future enhancements can implement session reuse logic here
		const sessionId = this.generateSessionId();
		const context: IChatSessionContext = {
			sessionId,
			history,
			chatAgentArgs
		};

		const session = this.createSession(sessionId, context);
		
		try {
			this._logService.logger.trace(`SessionManager: Executing request in session ${sessionId}`);
			const result = await session.execute(request, stream, token, onPaused);
			this._completedSessions++;
			this._logService.logger.trace(`SessionManager: Session ${sessionId} completed successfully`);
			return result;
		} catch (error) {
			this._failedSessions++;
			this._logService.logger.error(`SessionManager: Session ${sessionId} failed`, error);
			throw error;
		} finally {
			// Clean up the session immediately after use
			// Future enhancements can implement session persistence/reuse here
			this.cleanupSession(sessionId);
		}
	}

	/**
	 * Creates a new chat session
	 * @param sessionId Unique session identifier
	 * @param context Session context
	 * @param options Session options
	 * @returns The created chat session
	 */
	private createSession(
		sessionId: string,
		context: IChatSessionContext,
		options: IChatSessionOptions = {}
	): ChatSession {
		// Check concurrent session limit
		if (this._sessions.size >= this._options.maxConcurrentSessions!) {
			throw new Error(`Maximum concurrent sessions limit reached (${this._options.maxConcurrentSessions})`);
		}

		const session = this._instantiationService.createInstance(
			ChatSession,
			sessionId,
			context,
			options
		);

		this._sessions.set(sessionId, session);
		this._totalSessions++;

		this._logService.logger.debug(`SessionManager: Created session ${sessionId}`);
		return session;
	}

	/**
	 * Gets an existing session by ID
	 * @param sessionId The session ID to look up
	 * @returns The session if found, undefined otherwise
	 */
	getSession(sessionId: string): ChatSession | undefined {
		return this._sessions.get(sessionId);
	}

	/**
	 * Cleans up a session and removes it from tracking
	 * @param sessionId The session ID to clean up
	 */
	private cleanupSession(sessionId: string): void {
		const session = this._sessions.get(sessionId);
		if (session) {
			session.dispose();
			this._sessions.delete(sessionId);
			this._logService.logger.debug(`SessionManager: Cleaned up session ${sessionId}`);
		}
	}

	/**
	 * Gets all active sessions
	 * @returns Array of active session statistics
	 */
	getActiveSessions(): IChatSessionStats[] {
		return Array.from(this._sessions.values()).map(session => session.getStats());
	}

	/**
	 * Gets session manager statistics
	 * @returns Current statistics
	 */
	getStats(): ISessionManagerStats {
		return {
			totalSessions: this._totalSessions,
			activeSessions: this._sessions.size,
			completedSessions: this._completedSessions,
			failedSessions: this._failedSessions
		};
	}

	/**
	 * Generates a unique session ID
	 * @returns A new unique session ID
	 */
	private generateSessionId(): string {
		return `session-${generateUuid()}`;
	}

	/**
	 * Disposes of the session manager and all active sessions
	 */
	dispose(): void {
		this._logService.logger.debug('SessionManager: Disposing');
		
		// Clean up all active sessions
		for (const [sessionId] of this._sessions) {
			this.cleanupSession(sessionId);
		}

		this._disposables.dispose();
	}
}
