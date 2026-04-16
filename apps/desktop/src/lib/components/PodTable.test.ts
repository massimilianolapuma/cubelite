import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import PodTable from './PodTable.svelte';
import type { PodInfo } from '$lib/tauri';

describe('PodTable', () => {
	it('renders table headers', () => {
		render(PodTable, { props: { pods: [] } });

		expect(screen.getByText('Name')).toBeTruthy();
		expect(screen.getByText('Namespace')).toBeTruthy();
		expect(screen.getByText('Phase')).toBeTruthy();
		expect(screen.getByText('Ready')).toBeTruthy();
		expect(screen.getByText('Restarts')).toBeTruthy();
	});

	it('shows empty message when no pods', () => {
		render(PodTable, { props: { pods: [] } });

		expect(screen.getByText('No pods found.')).toBeTruthy();
	});

	it('renders pod rows', () => {
		const pods: PodInfo[] = [
			{ name: 'nginx-abc', namespace: 'default', phase: 'Running', ready: true, restarts: 0 },
			{ name: 'redis-xyz', namespace: 'kube-system', phase: 'Pending', ready: false, restarts: 2 }
		];

		render(PodTable, { props: { pods } });

		expect(screen.getByText('nginx-abc')).toBeTruthy();
		expect(screen.getByText('redis-xyz')).toBeTruthy();
		expect(screen.getByText('default')).toBeTruthy();
		expect(screen.getByText('kube-system')).toBeTruthy();
		expect(screen.getByText('Running')).toBeTruthy();
		expect(screen.getByText('Pending')).toBeTruthy();
	});

	it('displays ready status as Yes/No', () => {
		const pods: PodInfo[] = [
			{ name: 'ready-pod', namespace: 'default', phase: 'Running', ready: true, restarts: 0 },
			{ name: 'not-ready-pod', namespace: 'default', phase: 'Pending', ready: false, restarts: 0 }
		];

		render(PodTable, { props: { pods } });

		const yesElements = screen.getAllByText('Yes');
		const noElements = screen.getAllByText('No');
		expect(yesElements.length).toBe(1);
		expect(noElements.length).toBe(1);
	});

	it('displays restart count', () => {
		const pods: PodInfo[] = [
			{ name: 'crashloop-pod', namespace: 'default', phase: 'Running', ready: true, restarts: 42 }
		];

		render(PodTable, { props: { pods } });

		expect(screen.getByText('42')).toBeTruthy();
	});

	it('handles null phase with dash', () => {
		const pods: PodInfo[] = [
			{ name: 'unknown-pod', namespace: 'default', phase: null, ready: false, restarts: 0 }
		];

		render(PodTable, { props: { pods } });

		expect(screen.getByText('—')).toBeTruthy();
	});
});
