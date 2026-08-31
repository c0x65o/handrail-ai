import 'dart:convert';
import 'package:handrail_ai_client/handrail_ai_client.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

void main() {
  test(
    'reduces typed cross-platform turn state and calls thread resources',
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
                'descriptor': {'conversationId': 'c1'},
              },
            }),
            200,
          );
        }),
      );
      expect(
        await client.createConversation({'idempotencyKey': 'create-1'}),
        containsPair('value', isA<Map>()),
      );
      final running = const HandrailConversationState(conversationId: 'c1')
          .apply(
            const HandrailStreamFrame('event', null, {
              'event': {'type': 'response.started'},
            }),
          )
          .apply(
            const HandrailStreamFrame('event', null, {
              'event': {'type': 'response.text.delta', 'delta': 'Hello'},
            }),
          );
      expect(running.status, HandrailTurnStatus.running);
      expect(running.text, 'Hello');
      client.close();
    },
  );

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
            200,
          );
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

  test(
    'terminal frames preserve cancelled, failed, and disconnected outcomes',
    () {
      HandrailTurnStatus reduce(String status) =>
          const HandrailConversationState(conversationId: 'c1')
              .apply(
                HandrailStreamFrame('terminal', null, {
                  'type': 'terminal',
                  'result': {'status': status},
                }),
              )
              .status;
      expect(reduce('completed'), HandrailTurnStatus.completed);
      expect(reduce('cancelled'), HandrailTurnStatus.cancelled);
      expect(reduce('failed'), HandrailTurnStatus.failed);
      expect(reduce('disconnected'), HandrailTurnStatus.failed);
    },
  );

  test(
    'workspace keeps background conversations running and marks completion unread',
    () async {
      final workspace = HandrailConversationWorkspace();
      workspace.open(const HandrailConversationState(conversationId: 'first'));
      workspace.apply(
        'first',
        const HandrailStreamFrame('event', null, {
          'event': {'type': 'response.started'},
        }),
      );
      workspace.open(const HandrailConversationState(conversationId: 'second'));
      workspace.apply(
        'second',
        const HandrailStreamFrame('event', null, {
          'event': {'type': 'response.started'},
        }),
      );
      workspace.apply(
        'first',
        const HandrailStreamFrame('terminal', null, {
          'result': {'status': 'completed'},
        }),
      );

      expect(workspace.snapshot.runningCount, 1);
      expect(workspace.snapshot.unreadCount, 1);
      workspace.select('first');
      expect(workspace.snapshot.unreadCount, 0);
      workspace.replaceRemoteActivity([
        const HandrailConversationActivityRecord(
          conversationId: 'remote-running',
          status: HandrailTurnStatus.running,
          unread: false,
        ),
        const HandrailConversationActivityRecord(
          conversationId: 'remote-done',
          status: HandrailTurnStatus.completed,
          unread: true,
        ),
      ]);
      expect(workspace.snapshot.runningCount, 2);
      expect(workspace.snapshot.unreadCount, 1);
      workspace.markRemoteRead('remote-done');
      expect(workspace.snapshot.unreadCount, 0);
      await workspace.dispose();
    },
  );

  test('reports safe gateway diagnostics for resource failures', () async {
    final diagnostics = <Map<String, Object?>>[];
    final client = HandrailAiClient(
      baseUri: Uri.parse('https://app.example/api/ai'),
      diagnostics: diagnostics.add,
      httpClient: MockClient(
        (_) async => http.Response(
          jsonEncode({
            'ok': false,
            'error': {
              'code': 'upstream_unavailable',
              'message': 'Try later',
              'retryable': true,
            },
          }),
          503,
        ),
      ),
    );

    await expectLater(
      client.permanentlyDeleteConversation({'conversationId': 'c1'}),
      throwsA(isA<HandrailGatewayException>()),
    );
    expect(diagnostics.map((event) => event['phase']), ['started', 'failed']);
    expect(diagnostics.last, containsPair('code', 'upstream_unavailable'));
    expect(diagnostics.last, containsPair('retryable', true));
    client.close();
  });

  test('loads typed cross-device activity records', () async {
    final client = HandrailAiClient(
      baseUri: Uri.parse('https://app.example/api/ai'),
      httpClient: MockClient(
        (request) async => http.Response(
          jsonEncode({
            'ok': true,
            'value': [
              {
                'conversationId': 'remote-1',
                'turnStatus': 'completed',
                'unread': true,
                'updatedAt': '2026-01-01T00:00:00.000Z',
              },
            ],
          }),
          200,
        ),
      ),
    );
    final activity = await client.listActivity();
    expect(activity.single.conversationId, 'remote-1');
    expect(activity.single.status, HandrailTurnStatus.completed);
    expect(activity.single.unread, isTrue);
    client.close();
  });
}
