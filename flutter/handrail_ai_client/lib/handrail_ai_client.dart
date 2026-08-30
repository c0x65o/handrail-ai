library handrail_ai_client;

import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

const applicationGatewayProtocolVersion = 'handrail.application-gateway.v1';

typedef ProtectedHeaders = FutureOr<Map<String, String>> Function();

class HandrailGatewayCapabilities {
  final bool authoritativeCancellation;
  final Map<String, Object?>? attachments;
  final bool presence;
  final bool synchronization;
  const HandrailGatewayCapabilities({
    required this.authoritativeCancellation,
    this.attachments,
    required this.presence,
    required this.synchronization,
  });
  factory HandrailGatewayCapabilities.fromJson(Map<String, Object?> json) =>
      HandrailGatewayCapabilities(
        authoritativeCancellation: json['authoritativeCancellation'] == true,
        attachments: json['attachments'] is Map
            ? Map<String, Object?>.from(json['attachments'] as Map)
            : null,
        presence: json['presence'] == true,
        synchronization: json['synchronization'] == true,
      );
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
  }) => _stream('/turns/resume', {
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

  Stream<HandrailStreamFrame> _stream(
    String path,
    Map<String, Object?> payload,
  ) async* {
    final request = http.Request('POST', _uri(path))
      ..headers.addAll(await _headers())
      ..body = jsonEncode(payload);
    final response = await _http.send(request);
    if (response.statusCode < 200 || response.statusCode >= 300)
      throw http.ClientException(
        'Handrail gateway request failed (${response.statusCode})',
        request.url,
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
  }

  Map<String, Object?> _success(http.Response response) {
    final body = Map<String, Object?>.from(jsonDecode(response.body) as Map);
    if (response.statusCode < 200 ||
        response.statusCode >= 300 ||
        body['ok'] != true)
      throw StateError('Handrail gateway request failed');
    return body;
  }

  void close() => _http.close();
}
