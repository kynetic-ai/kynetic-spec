import { Command } from 'commander';
import chalk from 'chalk';
import {
  initContext,
  buildIndexes,
  updateSpecItem,
  type LoadedSpecItem,
} from '../../parser/index.js';
import { commitIfShadow } from '../../parser/shadow.js';
import { output, error, success, warn } from '../output.js';
import { errors } from '../../strings/errors.js';
import { labels } from '../../strings/labels.js';

/**
 * Valid relationship types
 */
const RELATIONSHIP_TYPES = ['depends_on', 'implements', 'relates_to'] as const;
type RelationshipType = typeof RELATIONSHIP_TYPES[number];

/**
 * Validate relationship type
 */
function isValidRelationshipType(type: string): type is RelationshipType {
  return RELATIONSHIP_TYPES.includes(type as RelationshipType);
}

/**
 * Register link commands
 */
export function registerLinkCommands(program: Command): void {
  const link = program
    .command('link')
    .description('Manage relationships between spec items');

  // kspec link create
  link
    .command('create')
    .description('Create a relationship from one item to another')
    .argument('<from>', 'Source item reference (e.g., @my-item)')
    .argument('<to>', 'Target item reference (e.g., @other-item)')
    .option('-t, --type <type>', 'Relationship type (depends_on, implements, relates_to)', 'relates_to')
    .action(async (fromRef: string, toRef: string, options) => {
      try {
        const ctx = await initContext();
        const { refIndex, itemIndex } = await buildIndexes(ctx);

        // Validate relationship type
        if (!isValidRelationshipType(options.type)) {
          error(errors.relationship.invalidType(options.type, RELATIONSHIP_TYPES.join(', ')));
          process.exit(1);
        }

        const relType = options.type as RelationshipType;

        // Resolve references
        const fromResult = refIndex.resolve(fromRef);
        if (!fromResult.ok) {
          error(errors.reference.itemNotFound(fromRef));
          process.exit(3);
        }

        const toResult = refIndex.resolve(toRef);
        if (!toResult.ok) {
          error(errors.reference.itemNotFound(toRef));
          process.exit(3);
        }

        const fromItem = fromResult.item;
        const toItem = toResult.item;

        // Ensure both are spec items (not tasks)
        if ('status' in fromItem && typeof fromItem.status === 'string') {
          error(errors.reference.notSpecItem(fromRef));
          process.exit(1);
        }

        if ('status' in toItem && typeof toItem.status === 'string') {
          error(errors.reference.notSpecItem(toRef));
          process.exit(1);
        }

        const fromSpecItem = fromItem as LoadedSpecItem;

        // Get existing relationships
        const existingRels = (fromSpecItem[relType] || []) as string[];

        // Check if relationship already exists
        if (existingRels.includes(toRef)) {
          warn(`Relationship already exists: ${fromRef} --[${relType}]--> ${toRef}`);
          output({ success: true, message: 'Relationship already exists' });
          return;
        }

        // Add the new relationship
        const newRels = [...existingRels, toRef];
        const updates = { [relType]: newRels };

        await updateSpecItem(ctx, fromSpecItem, updates);
        await commitIfShadow(ctx, `Add ${relType} link: ${fromRef} -> ${toRef}`);

        success(`Created relationship: ${fromRef} --[${relType}]--> ${toRef}`, { from: fromRef, to: toRef, type: relType });
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  // kspec link list
  link
    .command('list')
    .description('List relationships')
    .option('--from <ref>', 'Show relationships from this item')
    .option('--to <ref>', 'Show relationships to this item (reverse lookup)')
    .option('-t, --type <type>', 'Filter by relationship type')
    .action(async (options) => {
      try {
        const ctx = await initContext();
        const { refIndex, itemIndex, items } = await buildIndexes(ctx);

        // Validate type if provided
        if (options.type && !isValidRelationshipType(options.type)) {
          error(errors.relationship.invalidType(options.type, RELATIONSHIP_TYPES.join(', ')));
          process.exit(1);
        }

        const typeFilter = options.type as RelationshipType | undefined;

        // Case 1: List relationships FROM an item
        if (options.from) {
          const result = refIndex.resolve(options.from);
          if (!result.ok) {
            error(errors.reference.itemNotFound(options.from));
            process.exit(3);
          }

          const item = result.item;

          // Ensure it's a spec item
          if ('status' in item && typeof item.status === 'string') {
            error(errors.reference.notSpecItem(options.from));
            process.exit(1);
          }

          const specItem = item as LoadedSpecItem;
          const relationships: Array<{ type: RelationshipType; target: string }> = [];

          for (const relType of RELATIONSHIP_TYPES) {
            if (typeFilter && relType !== typeFilter) continue;

            const targets = (specItem[relType] || []) as string[];
            for (const target of targets) {
              relationships.push({ type: relType, target });
            }
          }

          if (relationships.length === 0) {
            console.log(chalk.gray(`No relationships found from ${options.from}`));
            output({ success: true, relationships: [] });
            return;
          }

          console.log(chalk.bold(`Relationships from ${options.from}:\n`));
          for (const rel of relationships) {
            const targetResult = refIndex.resolve(rel.target);
            const targetTitle = targetResult.ok ? targetResult.item.title : chalk.gray('(not found)');
            console.log(`  ${chalk.cyan(rel.type)}: ${chalk.yellow(rel.target)} - ${targetTitle}`);
          }
          console.log(chalk.gray(`\n${relationships.length} relationship(s)`));

          output({ success: true, from: options.from, relationships });
          return;
        }

        // Case 2: List relationships TO an item (reverse lookup)
        if (options.to) {
          const targetRef = options.to;
          const targetResult = refIndex.resolve(targetRef);
          if (!targetResult.ok) {
            error(errors.reference.itemNotFound(targetRef));
            process.exit(3);
          }

          const relationships: Array<{ type: RelationshipType; from: string }> = [];

          // Search all spec items for links to this target
          for (const item of items) {
            for (const relType of RELATIONSHIP_TYPES) {
              if (typeFilter && relType !== typeFilter) continue;

              const targets = (item[relType] || []) as string[];
              if (targets.includes(targetRef)) {
                const fromRef = item.slugs.length > 0 ? `@${item.slugs[0]}` : item._ulid;
                relationships.push({ type: relType, from: fromRef });
              }
            }
          }

          if (relationships.length === 0) {
            console.log(chalk.gray(`No relationships found to ${targetRef}`));
            output({ success: true, relationships: [] });
            return;
          }

          console.log(chalk.bold(`Relationships to ${targetRef}:\n`));
          for (const rel of relationships) {
            const fromResult = refIndex.resolve(rel.from);
            const fromTitle = fromResult.ok ? fromResult.item.title : chalk.gray('(not found)');
            console.log(`  ${chalk.yellow(rel.from)} - ${fromTitle} ${chalk.cyan(`--[${rel.type}]-->`)}`);
          }
          console.log(chalk.gray(`\n${relationships.length} relationship(s)`));

          output({ success: true, to: targetRef, relationships });
          return;
        }

        // Case 3: No filters - show all relationships
        const allRelationships: Array<{
          from: string;
          fromTitle: string;
          type: RelationshipType;
          to: string;
          toTitle: string;
        }> = [];

        for (const item of items) {
          const fromRef = item.slugs.length > 0 ? `@${item.slugs[0]}` : item._ulid;

          for (const relType of RELATIONSHIP_TYPES) {
            if (typeFilter && relType !== typeFilter) continue;

            const targets = (item[relType] || []) as string[];
            for (const target of targets) {
              const toResult = refIndex.resolve(target);
              allRelationships.push({
                from: fromRef,
                fromTitle: item.title,
                type: relType,
                to: target,
                toTitle: toResult.ok ? toResult.item.title : '(not found)',
              });
            }
          }
        }

        if (allRelationships.length === 0) {
          console.log(chalk.gray('No relationships found'));
          output({ success: true, relationships: [] });
          return;
        }

        console.log(chalk.bold('All relationships:\n'));
        for (const rel of allRelationships) {
          console.log(
            `  ${chalk.yellow(rel.from)} ${chalk.gray(rel.fromTitle)} ${chalk.cyan(`--[${rel.type}]-->`)} ${chalk.yellow(rel.to)} ${chalk.gray(rel.toTitle)}`
          );
        }
        console.log(chalk.gray(`\n${allRelationships.length} relationship(s)`));

        output({ success: true, relationships: allRelationships });
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  // kspec link delete
  link
    .command('delete')
    .description('Remove a relationship between items')
    .argument('<from>', 'Source item reference')
    .argument('<to>', 'Target item reference')
    .option('-t, --type <type>', 'Relationship type to remove (if not specified, removes from all types)')
    .action(async (fromRef: string, toRef: string, options) => {
      try {
        const ctx = await initContext();
        const { refIndex } = await buildIndexes(ctx);

        // Validate type if provided
        if (options.type && !isValidRelationshipType(options.type)) {
          error(errors.relationship.invalidType(options.type, RELATIONSHIP_TYPES.join(', ')));
          process.exit(1);
        }

        const typeFilter = options.type as RelationshipType | undefined;

        // Resolve references
        const fromResult = refIndex.resolve(fromRef);
        if (!fromResult.ok) {
          error(errors.reference.itemNotFound(fromRef));
          process.exit(3);
        }

        const toResult = refIndex.resolve(toRef);
        if (!toResult.ok) {
          error(errors.reference.itemNotFound(toRef));
          process.exit(3);
        }

        const fromItem = fromResult.item;

        // Ensure from is a spec item
        if ('status' in fromItem && typeof fromItem.status === 'string') {
          error(errors.reference.notSpecItem(fromRef));
          process.exit(1);
        }

        const fromSpecItem = fromItem as LoadedSpecItem;

        // Track which relationships were removed
        const removed: RelationshipType[] = [];
        const updates: Partial<Record<RelationshipType, string[]>> = {};

        // Remove from specified type or all types
        for (const relType of RELATIONSHIP_TYPES) {
          if (typeFilter && relType !== typeFilter) continue;

          const existingRels = (fromSpecItem[relType] || []) as string[];
          if (existingRels.includes(toRef)) {
            updates[relType] = existingRels.filter((r) => r !== toRef);
            removed.push(relType);
          }
        }

        if (removed.length === 0) {
          warn(`No relationship found: ${fromRef} --> ${toRef}`);
          output({ success: true, message: 'No relationship found' });
          return;
        }

        await updateSpecItem(ctx, fromSpecItem, updates);
        await commitIfShadow(ctx, `Remove ${removed.join(', ')} link: ${fromRef} -> ${toRef}`);

        const typesStr = removed.join(', ');
        success(`Removed relationship(s): ${fromRef} --[${typesStr}]--> ${toRef}`, { from: fromRef, to: toRef, types: removed });
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}
