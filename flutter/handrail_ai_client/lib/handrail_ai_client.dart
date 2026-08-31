library handrail_ai_client;

import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

const applicationGatewayProtocolVersion = 'handrail.application-gateway.v1';

typedef ProtectedHeaders = FutureOr<Map<String, String>> Function();

class HandrailGatewayCapabilities {
  final bool authoritativeCancellation;
  final Map<String, Object?>? attachments;
  final Map<String, Object?>? documentInput;
  final bool presence;
  final bool synchronization;
  final Map<String, Object?> resources;
  const HandrailGatewayCapabilities({
    required this.authoritativeCancellation,
    this.attachments,
    this.documentInput,
    required this.presence,
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
  failed
}

class HandrailConversationState {
  final String conversationId;
  final String text;
  final HandrailTurnStatus status;
  final List<Map<String, Object?>> toolCalls;
  final List<Map<String, Object?>> approvals;
  final List<Map<String, Object?>> citations;
  final List<Map<String, Object?>> attachments;
  const HandrailConversationState(
      {required this.conversationId,
      this.text = '',
      this.status = HandrailTurnStatus.idle,
      this.toolCalls = const [],
      this.approvals = const [],
      this.citations = const [],
      this.attachments = const []});

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
    if (type == 'response.completed' || frame.type == 'terminal')
      nextStatus = HandrailTurnStatus.completed;
    return HandrailConversationState(
        conversationId: conversationId,
        text: nextText,
        status: nextStatus,
        toolCalls: List.unmodifiable(nextTools),
        approvals: List.unmodifiable(nextApprovals),
        citations: List.unmodifiable(nextCitations),
        attachments: List.unmodifiable(nextAttachments));
  }
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
  HandrailAiClient({
    required this.baseUri,
    http.Client? httpClient,
    this.protectedHeaders,
  }) : _http = httpClient ?? http.Client();

  Future<Map<String, String>> _headers() async => {
        'content-type': 'application/json',
        ...?await protectedHeaders?.call(),
      };
  Uri _uri(String path) => baseUri.replace(
        path: '${baseUri.path.replaceFirst(RegExp(r'/$'), '')}$path',
      );

  Future<HandrailGatewayCapabilities> capabilities() async {
    final response = await _http.get(
      _uri('/capabilities'),
      headers: await _headers(),
    );
    final body = _success(response);
    final value = Map<String, Object?>.from(body['value'] as Map);
    if (value['protocolVersion'] != applicationGatewayProtocolVersion)
      throw StateError('Incompatible Handrail gateway protocol');
    return HandrailGatewayCapabilities.fromJson(value);
  }

  Stream<HandrailStreamFrame> startTurn(Map<String, Object?> request) =>
      _stream('/turns/start', request);
  Stream<HandrailStreamFrame> resumeTurn({
    required String conversationId,
    required String turnId,
    required Map<String, Object?> resumeFrom,
  }) =>
      _stream('/turns/resume', {
        'conversationId': conversationId,
        'turnId': turnId,
        'resumeFrom': resumeFrom,
      });

  Future<Map<String, Object?>> cancelTurn(Map<String, Object?> request) async {
    final response = await _http.post(
      _uri('/turns/cancel'),
      headers: await _headers(),
      body: jsonEncode(request),
    );
    return _success(response);
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
          Map<String, Object?> input) =>
      _post('/conversations/archive', input);
  Future<Map<String, Object?>> restoreConversation(
          Map<String, Object?> input) =>
      _post('/conversations/restore', input);
  Future<Map<String, Object?>> clearConversation(Map<String, Object?> input) =>
      _post('/conversations/clear', input);
  Future<Map<String, Object?>> createApproval(Map<String, Object?> input) =>
      _post('/approvals/create', input);
  Future<Map<String, Object?>> getApproval(String proposalId) =>
      _post('/approvals/get', {'proposalId': proposalId});
  Future<Map<String, Object?>> listApprovalGroup(String groupId) =>
      _post('/approvals/list-group', {'groupId': groupId});
  Future<Map<String, Object?>> transitionApproval(Map<String, Object?> input) =>
      _post('/approvals/transition', input);
  Future<String> generateTitle(
      {required String conversationId, required String idempotencyKey}) async {
    final result = await _post('/titles/generate',
        {'conversationId': conversationId, 'idempotencyKey': idempotencyKey});
    return result['value'] as String;
  }

  Future<Map<String, Object?>> synchronize(Map<String, Object?> input) =>
      _post('/synchronization', input);

  Stream<HandrailStreamFrame> presence(String conversationId) =>
      _streamRequest(http.Request(
          'GET',
          _uri('/presence')
              .replace(queryParameters: {'conversationId': conversationId})));

  Future<void> publishPresence(
      String conversationId, String kind, Map<String, Object?> record) async {
    final uri = _uri('/presence')
        .replace(queryParameters: {'conversationId': conversationId});
    final response = await _http.post(uri,
        headers: await _headers(),
        body: jsonEncode({'kind': kind, 'record': record}));
    _success(response);
  }

  Future<Map<String, Object?>> uploadAttachment(
      {required List<int> bytes,
      required String filename,
      required String mediaType,
      required String kind,
      required String idempotencyKey}) async {
    final request = http.MultipartRequest('POST', _uri('/attachments'))
      ..headers.addAll(await _headers())
      ..fields['kind'] = kind
      ..fields['mediaType'] = mediaType
      ..fields['idempotencyKey'] = idempotencyKey
      ..files
          .add(http.MultipartFile.fromBytes('file', bytes, filename: filename));
    final response = await http.Response.fromStream(await _http.send(request));
    return _success(response);
  }

  Future<Map<String, Object?>> _post(
      String path, Map<String, Object?> input) async {
    final response = await _http.post(_uri(path),
        headers: await _headers(), body: jsonEncode(input));
    return _success(response);
  }

  Stream<HandrailStreamFrame> _stream(
    String path,
    Map<String, Object?> payload,
  ) =>
      _streamRequest(
          http.Request('POST', _uri(path))..body = jsonEncode(payload));

  Stream<HandrailStreamFrame> _streamRequest(http.Request request) async* {
    request.headers.addAll(await _headers());
    final response = await _http.send(request);
    if (response.statusCode < 200 || response.statusCode >= 300)
      throw http.ClientException(
        'Handrail gateway request failed (${response.statusCode})',
        request.url,
      );
    String? eventType, eventId;
    final data = <String>[];
    await for (final line in response.stream
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
      else if (field == 'data') data.add(value);
    }
  }

  Map<String, Object?> _success(http.Response response) {
    final body = Map<String, Object?>.from(jsonDecode(response.body) as Map);
    if (response.statusCode < 200 ||
        response.statusCode >= 300 ||
        body['ok'] != true) throw StateError('Handrail gateway request failed');
    return body;
  }

  void close() => _http.close();
}
