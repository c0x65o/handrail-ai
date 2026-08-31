import 'dart:convert';
import 'package:handrail_ai_client/handrail_ai_client.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

void main() {
  test('reduces typed cross-platform turn state and calls thread resources',
      () async {
    final client = HandrailAiClient(
      baseUri: Uri.parse('https://app.example/api/ai'),
      httpClient: MockClient((request) async {
        expect(request.url.path, endsWith('/conversations/create'));
        return http.Response(
            jsonEncode({
              'ok': true,
              'value': {
                'operation': 'create',
                'status': 'created',
                'descriptor': {'conversationId': 'c1'}
              }
            }),
            200);
      }),
    );
    expect(await client.createConversation({'idempotencyKey': 'create-1'}),
        containsPair('value', isA<Map>()));
    final running = const HandrailConversationState(conversationId: 'c1')
        .apply(const HandrailStreamFrame('event', null, {
          'event': {'type': 'response.started'}
        }))
        .apply(const HandrailStreamFrame('event', null, {
          'event': {'type': 'response.text.delta', 'delta': 'Hello'}
        }));
    expect(running.status, HandrailTurnStatus.running);
    expect(running.text, 'Hello');
    client.close();
  });

  test('negotiates capabilities and parses SSE frames', () async {
    final client = HandrailAiClient(
      baseUri: Uri.parse('https://app.example/api/ai'),
      protectedHeaders: () => {'authorization': 'Bearer app'},
      httpClient: MockClient((request) async {
        expect(request.headers['authorization'], 'Bearer app');
        if (request.url.path.endsWith('/capabilities')) {
          return http.Response(
              jsonEncode({
                'ok': true,
                'value': {
                  'protocolVersion': applicationGatewayProtocolVersion,
                  'authoritativeCancellation': true,
                  'attachments': false,
                  'presence': true,
                  'synchronization': true,
                },
              }),
              200);
        }
        return http.Response(
          'event: event\nid: cursor-1\ndata: {"type":"event","event":{"type":"response.text.delta","delta":"Hi"},"checkpoint":{"lastAppliedCursor":"cursor-1"}}\n\n'
          'event: terminal\ndata: {"type":"terminal","result":{"status":"completed","checkpoint":{"lastAppliedCursor":"cursor-1"}}}\n\n',
          200,
          headers: {'content-type': 'text/event-stream'},
        );
      }),
    );
    expect((await client.capabilities()).presence, isTrue);
    final frames = await client.startTurn({'conversationId': 'c1'}).toList();
    expect(frames.map((frame) => frame.type), ['event', 'terminal']);
    expect(frames.first.id, 'cursor-1');
    client.close();
  });
}
