library handrail_ai_client;

import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

const applicationGatewayProtocolVersion = 'handrail.application-gateway.v1';

typedef ProtectedHeaders = FutureOr<Map<String, String>> Function();
typedef HandrailDiagnosticSink = void Function(Map<String, Object?> event);

class HandrailGatewayCapabilities {
  final bool authoritativeCancellation;
  final Map<String, Object?>? attachments;
  final Map<String, Object?>? documentInput;
  final bool presence;
  final bool activity;
  final bool synchronization;
  final Map<String, Object?> resources;
  const HandrailGatewayCapabilities({
    required this.authoritativeCancellation,
    this.attachments,
    this.documentInput,
    required this.presence,
    this.activity = false,
    required this.synchronization,
    this.resources = const {},
  });
  factory HandrailGatewayCapabilities.fromJson(Map<String, Object?> json) =>
      HandrailGatewayCapabilities(
        authoritativeCancellation: json['authoritativeCancellation'] == true,
        attachments: json['attachments'] is Map
            ? Map<String, Object?>.from(json['attachments'] as Map)
            : null,
        documentInput: json['documentInput'] is Map
            ? Map<String, Object?>.unmodifiable(json['documentInput'] as Map)
            : null,
        presence: json['presence'] == true,
        activity: json['activity'] == true,
        synchronization: json['synchronization'] == true,
        resources: json['resources'] is Map
            ? Map<String, Object?>.unmodifiable(json['resources'] as Map)
            : const {},
      );
}

enum HandrailTurnStatus {
  idle,
  running,
  waitingForTool,
  completed,
  cancelled,
  failed,
}

class HandrailConversationState {
  final String conversationId;
  final String text;
  final HandrailTurnStatus status;
  final List<Map<String, Object?>> toolCalls;
  final List<Map<String, Object?>> approvals;
  final List<Map<String, Object?>> citations;
  final List<Map<String, Object?>> attachments;
  const HandrailConversationState({
    required this.conversationId,
    this.text = '',
    this.status = HandrailTurnStatus.idle,
    this.toolCalls = const [],
    this.approvals = const [],
    this.citations = const [],
    this.attachments = const [],
  });

  HandrailConversationState apply(HandrailStreamFrame frame) {
    final payload = frame.data['event'] is Map
        ? Map<String, Object?>.from(frame.data['event'] as Map)
        : frame.data;
    final type = payload['type'];
    var nextStatus = status, nextText = text;
    final nextTools = [...toolCalls],
        nextApprovals = [...approvals],
        nextCitations = [...citations],
        nextAttachments = [...attachments];
    if (type == 'response.started') nextStatus = HandrailTurnStatus.running;
    if (type == 'response.text.delta')
      nextText += payload['delta'] as String? ?? '';
    if (type == 'response.tool_call') {
      nextStatus = HandrailTurnStatus.waitingForTool;
      nextTools.add(Map.unmodifiable(payload));
    }
    if (type == 'response.citation_batch')
      nextCitations.add(Map.unmodifiable(payload));
    if (type == 'approval.proposal_created' ||
        type == 'approval.proposal_status_changed')
      nextApprovals.add(Map.unmodifiable(payload));
    if (type == 'message.attachment_referenced')
      nextAttachments.add(Map.unmodifiable(payload));
    if (type == 'response.cancelled') nextStatus = HandrailTurnStatus.cancelled;
    if (type == 'response.error') nextStatus = HandrailTurnStatus.failed;
    if (type == 'response.completed') nextStatus = HandrailTurnStatus.completed;
    if (frame.type == 'terminal') {
      final terminal = frame.data['result'] is Map
          ? Map<String, Object?>.from(frame.data['result'] as Map)
          : frame.data;
      final terminalStatus = terminal['status'];
      if (terminalStatus == 'completed')
        nextStatus = HandrailTurnStatus.completed;
      if (terminalStatus == 'cancelled')
        nextStatus = HandrailTurnStatus.cancelled;
      if (terminalStatus == 'failed' || terminalStatus == 'disconnected')
        nextStatus = HandrailTurnStatus.failed;
    }
    return HandrailConversationState(
      conversationId: conversationId,
      text: nextText,
      status: nextStatus,
      toolCalls: List.unmodifiable(nextTools),
      approvals: List.unmodifiable(nextApprovals),
      citations: List.unmodifiable(nextCitations),
      attachments: List.unmodifiable(nextAttachments),
    );
  }
}

class HandrailConversationWorkspaceEntry {
  final HandrailConversationState state;
  final bool unread;
  const HandrailConversationWorkspaceEntry(this.state, {this.unread = false});
}

class HandrailConversationActivityRecord {
  final String conversationId;
  final HandrailTurnStatus status;
  final bool unread;
  final DateTime? updatedAt;
  const HandrailConversationActivityRecord({
    required this.conversationId,
    required this.status,
    required this.unread,
    this.updatedAt,
  });
  factory HandrailConversationActivityRecord.fromJson(
    Map<String, Object?> json,
  ) {
    final status = switch (json['turnStatus']) {
      'running' => HandrailTurnStatus.running,
      'completed' => HandrailTurnStatus.completed,
      'error' => HandrailTurnStatus.failed,
      _ => HandrailTurnStatus.idle,
    };
    return HandrailConversationActivityRecord(
      conversationId: json['conversationId'] as String,
      status: status,
      unread: json['unread'] == true,
      updatedAt: json['updatedAt'] is String
          ? DateTime.parse(json['updatedAt'] as String).toUtc()
          : null,
    );
  }
}

class HandrailConversationWorkspaceSnapshot {
  final String? selectedConversationId;
  final List<HandrailConversationWorkspaceEntry> conversations;
  final int runningCount;
  final int errorCount;
  final int unreadCount;
  const HandrailConversationWorkspaceSnapshot({
    required this.selectedConversationId,
    required this.conversations,
    required this.runningCount,
    required this.errorCount,
    required this.unreadCount,
  });
}

/// Tracks independent background turns so changing chats never stops a stream.
class HandrailConversationWorkspace {
  final Map<String, HandrailConversationWorkspaceEntry> _entries = {};
  final Map<String, HandrailConversationActivityRecord> _remoteActivity = {};
  final StreamController<HandrailConversationWorkspaceSnapshot> _changes =
      StreamController<HandrailConversationWorkspaceSnapshot>.broadcast(
        sync: true,
      );
  String? _selectedConversationId;

  Stream<HandrailConversationWorkspaceSnapshot> get changes => _changes.stream;
  HandrailConversationWorkspaceSnapshot get snapshot => _snapshot();

  void open(HandrailConversationState state, {bool select = true}) {
    final current = _entries[state.conversationId];
    _entries[state.conversationId] = HandrailConversationWorkspaceEntry(
      state,
      unread: current?.unread ?? false,
    );
    if (select) _selectedConversationId = state.conversationId;
    _publish();
  }

  HandrailConversationState apply(
    String conversationId,
    HandrailStreamFrame frame,
  ) {
    final current =
        _entries[conversationId] ??
        HandrailConversationWorkspaceEntry(
          HandrailConversationState(conversationId: conversationId),
        );
    final wasRunning =
        current.state.status == HandrailTurnStatus.running ||
        current.state.status == HandrailTurnStatus.waitingForTool;
    final next = current.state.apply(frame);
    final terminal =
        next.status == HandrailTurnStatus.completed ||
        next.status == HandrailTurnStatus.cancelled ||
        next.status == HandrailTurnStatus.failed;
    _entries[conversationId] = HandrailConversationWorkspaceEntry(
      next,
      unread:
          current.unread ||
          (_selectedConversationId != conversationId && wasRunning && terminal),
    );
    _publish();
    return next;
  }

  void select(String? conversationId) {
    _selectedConversationId = conversationId;
    final selected = conversationId == null ? null : _entries[conversationId];
    if (conversationId != null && selected != null && selected.unread) {
      _entries[conversationId] = HandrailConversationWorkspaceEntry(
        selected.state,
      );
    }
    _publish();
  }

  void close(String conversationId) {
    _entries.remove(conversationId);
    if (_selectedConversationId == conversationId)
      _selectedConversationId = null;
    _publish();
  }

  /// Replaces the server-backed index used for unopened or remotely running chats.
  void replaceRemoteActivity(
    Iterable<HandrailConversationActivityRecord> records,
  ) {
    _remoteActivity.clear();
    for (final record in records) {
      if (record.conversationId.isEmpty || record.conversationId.length > 256)
        throw ArgumentError.value(record.conversationId, 'conversationId');
      if (_remoteActivity.containsKey(record.conversationId))
        throw ArgumentError('Duplicate remote conversation activity');
      _remoteActivity[record.conversationId] = record;
    }
    _publish();
  }

  void markRemoteRead(String conversationId) {
    final current = _remoteActivity[conversationId];
    if (current == null || !current.unread) return;
    _remoteActivity[conversationId] = HandrailConversationActivityRecord(
      conversationId: current.conversationId,
      status: current.status,
      unread: false,
      updatedAt: current.updatedAt,
    );
    _publish();
  }

  HandrailConversationWorkspaceSnapshot _snapshot() {
    final values = List<HandrailConversationWorkspaceEntry>.unmodifiable(
      _entries.values,
    );
    final unopened = _remoteActivity.values.where(
      (record) => !_entries.containsKey(record.conversationId),
    );
    return HandrailConversationWorkspaceSnapshot(
      selectedConversationId: _selectedConversationId,
      conversations: values,
      runningCount:
          values
              .where(
                (entry) =>
                    entry.state.status == HandrailTurnStatus.running ||
                    entry.state.status == HandrailTurnStatus.waitingForTool,
              )
              .length +
          unopened
              .where(
                (record) =>
                    record.status == HandrailTurnStatus.running ||
                    record.status == HandrailTurnStatus.waitingForTool,
              )
              .length,
      errorCount:
          values
              .where((entry) => entry.state.status == HandrailTurnStatus.failed)
              .length +
          unopened
              .where((record) => record.status == HandrailTurnStatus.failed)
              .length,
      unreadCount:
          values.where((entry) => entry.unread).length +
          unopened.where((record) => record.unread).length,
    );
  }

  void _publish() {
    if (!_changes.isClosed) _changes.add(_snapshot());
  }

  Future<void> dispose() => _changes.close();
}

class HandrailGatewayException implements Exception {
  final String code;
  final String message;
  final bool retryable;
  final int? statusCode;
  const HandrailGatewayException(
    this.code,
    this.message, {
    this.retryable = false,
    this.statusCode,
  });
  @override
  String toString() => 'HandrailGatewayException($code): $message';
}

class HandrailStreamFrame {
  final String type;
  final String? id;
  final Map<String, Object?> data;
  const HandrailStreamFrame(this.type, this.id, this.data);
}

class HandrailAiClient {
  final Uri baseUri;
  final http.Client _http;
  final ProtectedHeaders? protectedHeaders;
  final HandrailDiagnosticSink? diagnostics;
  HandrailAiClient({
    required this.baseUri,
    http.Client? httpClient,
    this.protectedHeaders,
    this.diagnostics,
  }) : _http = httpClient ?? http.Client();

  Future<Map<String, String>> _headers() async => {
    'content-type': 'application/json',
    ...?await protectedHeaders?.call(),
  };
  Uri _uri(String path) => baseUri.replace(
    path: '${baseUri.path.replaceFirst(RegExp(r'/$'), '')}$path',
  );

  Future<HandrailGatewayCapabilities> capabilities() async {
    final started = DateTime.now();
    _diagnose('/capabilities', 'started');
    try {
      final response = await _http.get(
        _uri('/capabilities'),
        headers: await _headers(),
      );
      final body = _success(response);
      final value = Map<String, Object?>.from(body['value'] as Map);
      if (value['protocolVersion'] != applicationGatewayProtocolVersion)
        throw StateError('Incompatible Handrail gateway protocol');
      _diagnose(
        '/capabilities',
        'succeeded',
        started: started,
        statusCode: response.statusCode,
      );
      return HandrailGatewayCapabilities.fromJson(value);
    } catch (error) {
      _diagnoseFailure('/capabilities', started, error);
      rethrow;
    }
  }

  Stream<HandrailStreamFrame> startTurn(Map<String, Object?> request) =>
      _stream('/turns/start', request);
  Stream<HandrailStreamFrame> resumeTurn({
    required String conversationId,
    required String turnId,
    required Map<String, Object?> resumeFrom,
  }) => _stream('/turns/resume', {
    'conversationId': conversationId,
    'turnId': turnId,
    'resumeFrom': resumeFrom,
  });

  Future<Map<String, Object?>> cancelTurn(Map<String, Object?> request) async {
    return _post('/turns/cancel', request);
  }

  Future<Map<String, Object?>> listConversations(Map<String, Object?> input) =>
      _post('/conversations/list', input);
  Future<Map<String, Object?>> createConversation(Map<String, Object?> input) =>
      _post('/conversations/create', input);
  Future<Map<String, Object?>> getConversation(String conversationId) =>
      _post('/conversations/get', {'conversationId': conversationId});
  Future<Map<String, Object?>> renameConversation(Map<String, Object?> input) =>
      _post('/conversations/rename', input);
  Future<Map<String, Object?>> archiveConversation(
    Map<String, Object?> input,
  ) => _post('/conversations/archive', input);
  Future<Map<String, Object?>> restoreConversation(
    Map<String, Object?> input,
  ) => _post('/conversations/restore', input);
  Future<Map<String, Object?>> clearConversation(Map<String, Object?> input) =>
      _post('/conversations/clear', input);
  Future<Map<String, Object?>> permanentlyDeleteConversation(
    Map<String, Object?> input,
  ) => _post('/conversations/permanent-delete', input);
  Future<Map<String, Object?>> createApproval(Map<String, Object?> input) =>
      _post('/approvals/create', input);
  Future<Map<String, Object?>> getApproval(String proposalId) =>
      _post('/approvals/get', {'proposalId': proposalId});
  Future<Map<String, Object?>> listApprovalGroup(String groupId) =>
      _post('/approvals/list-group', {'groupId': groupId});
  Future<Map<String, Object?>> transitionApproval(Map<String, Object?> input) =>
      _post('/approvals/transition', input);
  Future<String> generateTitle({
    required String conversationId,
    required String idempotencyKey,
  }) async {
    final result = await _post('/titles/generate', {
      'conversationId': conversationId,
      'idempotencyKey': idempotencyKey,
    });
    return result['value'] as String;
  }

  Future<Map<String, Object?>> synchronize(Map<String, Object?> input) =>
      _post('/synchronization', input);

  Future<List<HandrailConversationActivityRecord>> listActivity() async {
    final result = await _post('/activity', {'operation': 'list'});
    final values = result['value'] as List? ?? const [];
    return List.unmodifiable(
      values.map(
        (value) => HandrailConversationActivityRecord.fromJson(
          Map<String, Object?>.from(value as Map),
        ),
      ),
    );
  }

  Future<HandrailConversationActivityRecord?> markActivityRead(
    String conversationId,
  ) async {
    final result = await _post('/activity', {
      'operation': 'mark_read',
      'conversationId': conversationId,
    });
    return result['value'] is Map
        ? HandrailConversationActivityRecord.fromJson(
            Map<String, Object?>.from(result['value'] as Map),
          )
        : null;
  }

  Stream<HandrailStreamFrame> presence(String conversationId) => _streamRequest(
    http.Request(
      'GET',
      _uri(
        '/presence',
      ).replace(queryParameters: {'conversationId': conversationId}),
    ),
  );

  Future<void> publishPresence(
    String conversationId,
    String kind,
    Map<String, Object?> record,
  ) async {
    final uri = _uri(
      '/presence',
    ).replace(queryParameters: {'conversationId': conversationId});
    final response = await _http.post(
      uri,
      headers: await _headers(),
      body: jsonEncode({'kind': kind, 'record': record}),
    );
    _success(response);
  }

  Future<Map<String, Object?>> uploadAttachment({
    required List<int> bytes,
    required String filename,
    required String mediaType,
    required String kind,
    required String idempotencyKey,
  }) async {
    final request = http.MultipartRequest('POST', _uri('/attachments'))
      ..headers.addAll(await _headers())
      ..fields['kind'] = kind
      ..fields['mediaType'] = mediaType
      ..fields['idempotencyKey'] = idempotencyKey
      ..files.add(
        http.MultipartFile.fromBytes('file', bytes, filename: filename),
      );
    final response = await http.Response.fromStream(await _http.send(request));
    return _success(response);
  }

  Future<Map<String, Object?>> _post(
    String path,
    Map<String, Object?> input,
  ) async {
    final started = DateTime.now();
    _diagnose(path, 'started');
    try {
      final response = await _http.post(
        _uri(path),
        headers: await _headers(),
        body: jsonEncode(input),
      );
      final value = _success(response);
      _diagnose(
        path,
        'succeeded',
        started: started,
        statusCode: response.statusCode,
      );
      return value;
    } catch (error) {
      _diagnose(
        path,
        'failed',
        started: started,
        code: error is HandrailGatewayException
            ? error.code
            : error.runtimeType.toString(),
        retryable: error is HandrailGatewayException && error.retryable,
        statusCode: error is HandrailGatewayException ? error.statusCode : null,
      );
      rethrow;
    }
  }

  Stream<HandrailStreamFrame> _stream(
    String path,
    Map<String, Object?> payload,
  ) => _streamRequest(
    http.Request('POST', _uri(path))..body = jsonEncode(payload),
  );

  Stream<HandrailStreamFrame> _streamRequest(http.Request request) async* {
    final operation = request.url.path;
    final started = DateTime.now();
    _diagnose(operation, 'started');
    try {
      request.headers.addAll(await _headers());
      final response = await _http.send(request);
      if (response.statusCode < 200 || response.statusCode >= 300)
        throw HandrailGatewayException(
          'stream_request_failed',
          'Handrail gateway stream request failed.',
          retryable: response.statusCode >= 500 || response.statusCode == 429,
          statusCode: response.statusCode,
        );
      String? eventType, eventId;
      final data = <String>[];
      await for (final line
          in response.stream
              .transform(utf8.decoder)
              .transform(const LineSplitter())) {
        if (line.isEmpty) {
          if (data.isNotEmpty)
            yield HandrailStreamFrame(
              eventType ?? 'message',
              eventId,
              Map<String, Object?>.from(jsonDecode(data.join('\n')) as Map),
            );
          eventType = null;
          eventId = null;
          data.clear();
          continue;
        }
        if (line.startsWith(':')) continue;
        final colon = line.indexOf(':');
        final field = colon < 0 ? line : line.substring(0, colon);
        final value = colon < 0
            ? ''
            : line.substring(colon + 1).replaceFirst(RegExp(r'^ '), '');
        if (field == 'event')
          eventType = value;
        else if (field == 'id')
          eventId = value;
        else if (field == 'data')
          data.add(value);
      }
      _diagnose(
        operation,
        'succeeded',
        started: started,
        statusCode: response.statusCode,
      );
    } catch (error) {
      _diagnose(
        operation,
        'failed',
        started: started,
        code: error is HandrailGatewayException
            ? error.code
            : error.runtimeType.toString(),
        retryable: error is HandrailGatewayException && error.retryable,
        statusCode: error is HandrailGatewayException ? error.statusCode : null,
      );
      rethrow;
    }
  }

  void _diagnose(
    String operation,
    String phase, {
    DateTime? started,
    String? code,
    bool? retryable,
    int? statusCode,
  }) {
    final sink = diagnostics;
    if (sink == null) return;
    try {
      sink(
        Map<String, Object?>.unmodifiable({
          'domain': 'gateway',
          'operation': operation,
          'phase': phase,
          'timestamp': DateTime.now().toUtc().toIso8601String(),
          if (started != null)
            'durationMs': DateTime.now().difference(started).inMilliseconds,
          if (code != null) 'code': code,
          if (retryable != null) 'retryable': retryable,
          if (statusCode != null) 'statusCode': statusCode,
        }),
      );
    } catch (_) {
      // Observability is non-authoritative.
    }
  }

  void _diagnoseFailure(String operation, DateTime started, Object error) {
    _diagnose(
      operation,
      'failed',
      started: started,
      code: error is HandrailGatewayException
          ? error.code
          : error.runtimeType.toString(),
      retryable: error is HandrailGatewayException && error.retryable,
      statusCode: error is HandrailGatewayException ? error.statusCode : null,
    );
  }

  Map<String, Object?> _success(http.Response response) {
    Map<String, Object?> body;
    try {
      body = Map<String, Object?>.from(jsonDecode(response.body) as Map);
    } catch (_) {
      throw HandrailGatewayException(
        'invalid_response',
        'Handrail gateway returned an invalid response.',
        retryable: response.statusCode >= 500,
        statusCode: response.statusCode,
      );
    }
    if (response.statusCode < 200 ||
        response.statusCode >= 300 ||
        body['ok'] != true) {
      final error = body['error'] is Map
          ? Map<String, Object?>.from(body['error'] as Map)
          : const <String, Object?>{};
      throw HandrailGatewayException(
        error['code'] as String? ?? 'request_failed',
        error['message'] as String? ?? 'Handrail gateway request failed.',
        retryable: error['retryable'] == true,
        statusCode: response.statusCode,
      );
    }
    return body;
  }

  void close() => _http.close();
}
