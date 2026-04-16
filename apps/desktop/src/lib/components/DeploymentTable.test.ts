import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import DeploymentTable from './DeploymentTable.svelte';
import type { DeploymentInfo } from '$lib/tauri';

describe('DeploymentTable', () => {
	it('renders table headers', () => {
		render(DeploymentTable, { props: { deployments: [] } });

		expect(screen.getByText('Name')).toBeTruthy();
		expect(screen.getByText('Namespace')).toBeTruthy();
		expect(screen.getByText('Ready')).toBeTruthy();
		expect(screen.getByText('Replicas')).toBeTruthy();
	});

	it('shows empty message when no deployments', () => {
		render(DeploymentTable, { props: { deployments: [] } });

		expect(screen.getByText('No deployments found.')).toBeTruthy();
	});

	it('renders deployment rows', () => {
		const deployments: DeploymentInfo[] = [
			{ name: 'nginx', namespace: 'default', replicas: 3, ready_replicas: 3 },
			{ name: 'api-server', namespace: 'production', replicas: 5, ready_replicas: 2 }
		];

		render(DeploymentTable, { props: { deployments } });

		expect(screen.getByText('nginx')).toBeTruthy();
		expect(screen.getByText('api-server')).toBeTruthy();
		expect(screen.getByText('default')).toBeTruthy();
		expect(screen.getByText('production')).toBeTruthy();
	});

	it('displays ready/replicas ratio', () => {
		const deployments: DeploymentInfo[] = [
			{ name: 'nginx', namespace: 'default', replicas: 3, ready_replicas: 3 }
		];

		render(DeploymentTable, { props: { deployments } });

		expect(screen.getByText('3/3')).toBeTruthy();
	});

	it('displays degraded deployment ratio', () => {
		const deployments: DeploymentInfo[] = [
			{ name: 'failing-app', namespace: 'staging', replicas: 5, ready_replicas: 1 }
		];

		render(DeploymentTable, { props: { deployments } });

		expect(screen.getByText('1/5')).toBeTruthy();
	});

	it('displays total replicas column', () => {
		const deployments: DeploymentInfo[] = [
			{ name: 'nginx', namespace: 'default', replicas: 10, ready_replicas: 8 }
		];

		render(DeploymentTable, { props: { deployments } });

		expect(screen.getByText('10')).toBeTruthy();
	});
});
