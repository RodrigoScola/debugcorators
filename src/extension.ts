import * as vscode from 'vscode';
import * as ts from 'typescript';

interface FunctionInfo {
	name: string;
	start: number;
	end: number;
}

export function activate(context: vscode.ExtensionContext) {
	// Create a DiagnosticCollection for your extension
	const diagnosticCollection = vscode.languages.createDiagnosticCollection('myDiagnostics');
	context.subscriptions.push(diagnosticCollection);

	// Run diagnostics on activate
	runDiagnostics(diagnosticCollection);

	vscode.commands.registerCommand('debugcorators.helloWorld', () => {
		vscode.window.showInformationMessage('hello there');
	});

	// Optional: Run diagnostics when files change or save
	vscode.workspace.onDidSaveTextDocument(
		(doc) => {
			runDiagnostics(diagnosticCollection, doc);
		},
		null,
		context.subscriptions
	);
}

async function runDiagnostics(diagnosticCollection: vscode.DiagnosticCollection, doc?: vscode.TextDocument) {
	const filesToCheck = doc ? [doc.uri] : await vscode.workspace.findFiles('**/*.ts');

	for (const file of filesToCheck) {
		const document =
			doc && file.toString() === doc.uri.toString()
				? doc
				: await vscode.workspace.openTextDocument(file);

		const functions = findCallsToThrowsFunctionsOutsideTry(document.getText());
		if (functions.length === 0) {
			diagnosticCollection.delete(file);
			continue;
		}

		const diagnostics: vscode.Diagnostic[] = [];
		for (const fn of functions) {
			const startPos = document.positionAt(fn.start);
			const endPos = document.positionAt(fn.end);
			const range = new vscode.Range(startPos, endPos);

			const diag = new vscode.Diagnostic(
				range,
				`Function throws but try catch is not being used`,
				vscode.DiagnosticSeverity.Warning
			);
			diagnostics.push(diag);
		}
		diagnosticCollection.set(file, diagnostics);
	}
}

/**
 * @throws
 */
// Finds all functions or methods with @throws decorator or JSDoc tag, returning name and range
function findCallsToThrowsFunctionsOutsideTry(sourceCode: string): FunctionInfo[] {
	const sourceFile = ts.createSourceFile('temp.ts', sourceCode, ts.ScriptTarget.Latest, true);
	const throwsFunctions = new Map<
		string,
		{
			isAsync: boolean;
		}
	>();

	// Step 1: collect all function names that throw
	function collectThrowsFunctions(node: ts.Node) {
		if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
			const nameNode = node.name;
			if (!nameNode || !ts.isIdentifier(nameNode)) {
				return;
			}

			const name = nameNode.text;
			let isThrows = false;

			// ✅ Check decorators
			const decorators = (node as any).decorators;
			isThrows ||= decorators?.some((dec: ts.Decorator) => {
				const expr = dec.expression;
				return ts.isIdentifier(expr) && expr.text === 'throws';
			});

			// ✅ Check JSDoc-style comments
			const jsDocs = (node as any).jsDoc as ts.JSDoc[] | undefined;
			isThrows ||=
				jsDocs?.some((jsDoc) => jsDoc.tags?.some((tag) => tag.tagName.text === 'throws')) ?? false;

			// ✅ Check preceding `// @throws` comment
			const commentRanges = ts.getLeadingCommentRanges(sourceCode, node.pos);
			if (commentRanges) {
				for (const comment of commentRanges) {
					const commentText = sourceCode.slice(comment.pos, comment.end);
					if (commentText.includes('@throws')) {
						isThrows = true;
						break;
					}
				}
			}

			if (isThrows) {
				const isAsync = !!node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.AsyncKeyword);
				throwsFunctions.set(name, {
					isAsync,
				});
			}
		}
		ts.forEachChild(node, collectThrowsFunctions);
	}

	// Helper: is node inside a try block
	function isHandled(node: ts.CallExpression, isAsync: boolean): boolean {
		const isAwaited = node.parent && ts.isAwaitExpression(node.parent);

		// ✅ 1. Check try/catch if awaited
		let current = node.parent;
		if (isAsync && isAwaited) {
			while (current) {
				if (ts.isTryStatement(current)) {
					const tryBlock = current.tryBlock;
					if (node.getStart() >= tryBlock.getStart() && node.getEnd() <= tryBlock.getEnd()) {
						return true;
					}
				}
				current = current.parent;
			}
		}

		// ✅ 2. Check for `.catch()` chain
		const maybeThenable = node.parent;
		if (ts.isPropertyAccessExpression(maybeThenable) || ts.isCallExpression(maybeThenable)) {
			const chain = maybeThenable.parent;
			if (ts.isCallExpression(chain) && ts.isPropertyAccessExpression(chain.expression)) {
				const prop = chain.expression.name.text;
				if (prop === 'catch') {
					return true;
				}
			}
		}

		return false;
	}

	// Step 2: find unwrapped call expressions to those functions
	const results: FunctionInfo[] = [];

	function findCalls(node: ts.Node) {
		if (ts.isCallExpression(node)) {
			const expr = node.expression;
			if (ts.isIdentifier(expr)) {
				const meta = throwsFunctions.get(expr.text);
				if (meta) {
					const isAsync = meta.isAsync;
					if (!isHandled(node, isAsync)) {
						results.push({
							name: expr.text,
							start: node.getStart(sourceFile),
							end: node.getEnd(),
						});
					}
				}
			}
		}
		ts.forEachChild(node, findCalls);
	}

	collectThrowsFunctions(sourceFile);
	findCalls(sourceFile);
	return results;
}

export function deactivate() {}
